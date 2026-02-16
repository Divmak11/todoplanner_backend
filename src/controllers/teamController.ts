import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { admin, db, auth } from '../config/firebase-admin';
import { Collections, UserRole, TaskStatus, NotificationType } from '../config/constants';
import {
  validateAuthenticated,
  validateSuperAdminAsync,
  validateRequiredString,
  validateNonEmptyArray,
} from '../utils/validators';
import {
  sendMulticastNotification,
  sendNotification,
  createNotificationData,
} from '../services/notificationService';
import { CreateTeamInput, UpdateTeamInput, DeleteTeamInput } from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Sync a user's role based on whether they are admin of any team.
 * - If admin of at least one team and currently a member → promote to team_admin
 * - If admin of zero teams and currently team_admin → demote to member
 * - Super Admins are never touched.
 *
 * Must be called AFTER the team document changes have been committed.
 */
async function syncTeamAdminRole(
  userId: string,
  txOrBatch?: FirebaseFirestore.WriteBatch
): Promise<void> {
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  if (!userDoc.exists) return;

  const userData = userDoc.data()!;
  const currentRole: string = userData.role;

  // Never touch Super Admins
  if (currentRole === UserRole.SUPER_ADMIN) return;

  const teamsAsAdmin = await db
    .collection(Collections.TEAMS)
    .where('adminId', '==', userId)
    .limit(1)
    .get();

  const isAdminOfAnyTeam = !teamsAsAdmin.empty;
  const userRef = db.collection(Collections.USERS).doc(userId);

  if (isAdminOfAnyTeam && currentRole !== UserRole.TEAM_ADMIN) {
    // Promote to team_admin
    if (txOrBatch) {
      txOrBatch.update(userRef, {
        role: UserRole.TEAM_ADMIN,
        roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.update({
        role: UserRole.TEAM_ADMIN,
        roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await auth.setCustomUserClaims(userId, { role: UserRole.TEAM_ADMIN });
  } else if (!isAdminOfAnyTeam && currentRole === UserRole.TEAM_ADMIN) {
    // Demote to member
    if (txOrBatch) {
      txOrBatch.update(userRef, {
        role: UserRole.MEMBER,
        roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await userRef.update({
        role: UserRole.MEMBER,
        roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await auth.setCustomUserClaims(userId, { role: UserRole.MEMBER });
  }
}

/**
 * Create a new team
 * Only Super Admin can call this function
 */
export const createTeam = onCall(
  callableConfig,
  async (request: CallableRequest<CreateTeamInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const name = validateRequiredString(data.name, 'Team name');
    const memberIds = validateNonEmptyArray<string>(data.memberIds, 'memberIds');
    const teamAdminId = validateRequiredString(data.adminId, 'adminId');

    // Validate team name length
    if (name.length < 2 || name.length > 50) {
      throw new HttpsError(
        'invalid-argument',
        'Team name must be between 2 and 50 characters'
      );
    }

    // Validate team admin is in members list
    if (!memberIds.includes(teamAdminId)) {
      throw new HttpsError(
        'invalid-argument',
        'Team admin must be in the members list'
      );
    }

    // Validate all members exist and are active
    for (const memberId of memberIds) {
      const userDoc = await db.collection(Collections.USERS).doc(memberId).get();
      if (!userDoc.exists) {
        throw new HttpsError(
          'not-found',
          `User ${memberId} not found`
        );
      }
      const user = userDoc.data()!;
      if (user.status !== 'active') {
        throw new HttpsError(
          'failed-precondition',
          `User ${memberId} is not active`
        );
      }
    }

    // Create team document
    const teamRef = await db.collection(Collections.TEAMS).add({
      name,
      memberIds,
      adminId: teamAdminId,
      createdBy: adminId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update all members' teamIds array
    const batch = db.batch();
    for (const memberId of memberIds) {
      batch.update(db.collection(Collections.USERS).doc(memberId), {
        teamIds: admin.firestore.FieldValue.arrayUnion(teamRef.id),
      });
    }
    await batch.commit();

    // Auto-promote the designated admin to team_admin role (if not already super_admin)
    await syncTeamAdminRole(teamAdminId);

    // Send notifications AFTER all writes have committed
    await sendMulticastNotification(
      memberIds,
      '👥 Team Update',
      `Added to ${name}`,
      createNotificationData(NotificationType.TEAM_CREATED, { teamId: teamRef.id })
    );

    return { success: true, teamId: teamRef.id };
  }
);

/**
 * Update a team (name, members, admin)
 *
 * Permissions:
 * - Super Admin: can update name, memberIds, adminId
 * - Team Admin: can only update name
 *
 * Uses a Firestore transaction to prevent TOCTOU race conditions.
 * Auto-manages team_admin role: promotes new admin, conditionally demotes old admin.
 */
export const updateTeam = onCall(
  callableConfig,
  async (request: CallableRequest<UpdateTeamInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const teamId = validateRequiredString(data.teamId, 'teamId');
    const updates = data.updates;

    if (!updates || Object.keys(updates).length === 0) {
      throw new HttpsError(
        'invalid-argument',
        'No updates provided'
      );
    }

    // Determine caller role with Firestore fallback (async, not sync custom claims)
    const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
    if (!callerDoc.exists) {
      throw new HttpsError('unauthenticated', 'Caller user document not found');
    }
    const callerRole = callerDoc.data()!.role;
    const isSuperAdmin = callerRole === UserRole.SUPER_ADMIN;

    // Field-level restriction: Only Super Admin can modify adminId or memberIds
    if (!isSuperAdmin) {
      if (updates.adminId !== undefined) {
        throw new HttpsError(
          'permission-denied',
          'Only Super Admin can change the Team Admin'
        );
      }
      if (updates.memberIds !== undefined) {
        throw new HttpsError(
          'permission-denied',
          'Only Super Admin can modify team members'
        );
      }
    }

    // Validate name length if provided
    if (updates.name !== undefined) {
      const trimmedName = updates.name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 50) {
        throw new HttpsError(
          'invalid-argument',
          'Team name must be between 2 and 50 characters'
        );
      }
    }

    // Track admin change for post-commit role sync
    let oldAdminId: string | null = null;
    let newAdminId: string | null = null;

    // Track member changes for post-commit notifications
    let addedMembers: string[] = [];
    let removedMembers: string[] = [];
    let teamName = '';

    // Use a transaction to prevent TOCTOU race conditions
    await db.runTransaction(async (transaction) => {
      const teamDoc = await transaction.get(
        db.collection(Collections.TEAMS).doc(teamId)
      );

      if (!teamDoc.exists) {
        throw new HttpsError('not-found', 'Team not found');
      }

      const team = teamDoc.data()!;
      teamName = team.name;

      // Verify caller is Super Admin or Team Admin of this specific team
      const isTeamAdmin = team.adminId === callerId;
      if (!(isSuperAdmin || isTeamAdmin)) {
        throw new HttpsError(
          'permission-denied',
          'Only Super Admin or Team Admin can update this team'
        );
      }

      const updateData: Record<string, unknown> = {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: callerId,
      };

      // Handle name update (allowed for both Super Admin and Team Admin)
      if (updates.name !== undefined) {
        updateData.name = updates.name.trim();
        teamName = updateData.name as string;
      }

      // Handle adminId update (Super Admin only — already validated above)
      if (updates.adminId !== undefined) {
        const requestedAdminId = validateRequiredString(updates.adminId, 'adminId');
        const currentMembers = updates.memberIds || team.memberIds;

        if (!currentMembers.includes(requestedAdminId)) {
          throw new HttpsError(
            'invalid-argument',
            'New admin must be a team member'
          );
        }

        if (requestedAdminId !== team.adminId) {
          oldAdminId = team.adminId;
          newAdminId = requestedAdminId;
          updateData.adminId = requestedAdminId;
        }
      }

      // Handle members update (Super Admin only — already validated above)
      if (updates.memberIds !== undefined) {
        const newMemberIds = validateNonEmptyArray<string>(updates.memberIds, 'memberIds');
        const oldMemberIds: string[] = team.memberIds;

        // Validate admin is in new members list
        const finalAdminId = updates.adminId || team.adminId;
        if (finalAdminId && !newMemberIds.includes(finalAdminId)) {
          throw new HttpsError(
            'invalid-argument',
            'Team admin must remain in the members list'
          );
        }

        // Find added and removed members
        addedMembers = newMemberIds.filter((id) => !oldMemberIds.includes(id));
        removedMembers = oldMemberIds.filter((id) => !newMemberIds.includes(id));

        // Update added members' teamIds
        for (const memberId of addedMembers) {
          transaction.update(db.collection(Collections.USERS).doc(memberId), {
            teamIds: admin.firestore.FieldValue.arrayUnion(teamId),
          });
        }

        // Update removed members' teamIds
        for (const memberId of removedMembers) {
          transaction.update(db.collection(Collections.USERS).doc(memberId), {
            teamIds: admin.firestore.FieldValue.arrayRemove(teamId),
          });
        }

        updateData.memberIds = newMemberIds;
      }

      transaction.update(db.collection(Collections.TEAMS).doc(teamId), updateData);
    });

    // --- Post-commit: role sync and notifications (AFTER transaction succeeds) ---

    // Auto-manage team_admin roles if admin changed
    if (newAdminId) {
      await syncTeamAdminRole(newAdminId);
    }
    if (oldAdminId) {
      await syncTeamAdminRole(oldAdminId);
    }

    // Send notifications for member changes
    if (addedMembers.length > 0) {
      await sendMulticastNotification(
        addedMembers,
        '👥 Team Update',
        `Added to ${teamName}`,
        createNotificationData(NotificationType.MEMBER_ADDED, { teamId })
      );
    }

    if (removedMembers.length > 0) {
      await sendMulticastNotification(
        removedMembers,
        '👥 Team Update',
        `Removed from ${teamName}`,
        createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
      );
    }

    // Notify about admin change
    if (newAdminId && oldAdminId) {
      await sendNotification(
        newAdminId,
        '👑 Admin Role',
        `You are now the admin of ${teamName}`,
        createNotificationData(NotificationType.ROLE_CHANGED, { teamId })
      );
      await sendNotification(
        oldAdminId,
        '👑 Admin Change',
        `You are no longer the admin of ${teamName}`,
        createNotificationData(NotificationType.ROLE_CHANGED, { teamId })
      );
    }

    return { success: true, message: 'Team updated successfully' };
  }
);

/**
 * Delete a team and cleanup related data
 * Only Super Admin can call this function
 */
export const deleteTeam = onCall(
  callableConfig,
  async (request: CallableRequest<DeleteTeamInput>) => {
    const context = { auth: request.auth };
    const data = request.data;

    await validateSuperAdminAsync(context);
    const teamId = validateRequiredString(data.teamId, 'teamId');

    const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
    if (!teamDoc.exists) {
      throw new HttpsError('not-found', 'Team not found');
    }

    const team = teamDoc.data()!;
    const memberIds: string[] = team.memberIds;
    const teamAdminId: string | null = team.adminId || null;

    const batch = db.batch();

    // 1. Cancel all ongoing team tasks
    const teamTasks = await db
      .collection(Collections.TASKS)
      .where('assignedTo', '==', teamId)
      .where('assignedType', '==', 'team')
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    teamTasks.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      batch.update(doc.ref, {
        status: TaskStatus.CANCELLED,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 2. Remove team ID from all members
    for (const memberId of memberIds) {
      batch.update(db.collection(Collections.USERS).doc(memberId), {
        teamIds: admin.firestore.FieldValue.arrayRemove(teamId),
      });
    }

    // 3. Delete team document
    batch.delete(db.collection(Collections.TEAMS).doc(teamId));

    await batch.commit();

    // 4. Auto-demote the old admin if they are no longer admin of any other team
    if (teamAdminId) {
      await syncTeamAdminRole(teamAdminId);
    }

    // 5. Notify members AFTER all writes committed
    await sendMulticastNotification(
      memberIds,
      '🗑️ Team Deleted',
      `${team.name} has been dissolved`,
      createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
    );

    return { success: true, message: 'Team deleted successfully' };
  }
);
