import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { admin, db } from '../config/firebase-admin';
import { Collections, UserRole, TaskStatus, NotificationType } from '../config/constants';
import {
  validateAuthenticated,
  validateSuperAdmin,
  validateRequiredString,
  validateNonEmptyArray,
} from '../utils/validators';
import {
  sendMulticastNotification,
  createNotificationData,
} from '../services/notificationService';
import { CreateTeamInput, UpdateTeamInput, DeleteTeamInput } from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Create a new team
 * Only Super Admin can call this function
 */
export const createTeam = onCall(
  callableConfig,
  async (request: CallableRequest<CreateTeamInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = validateSuperAdmin(context);
    const name = validateRequiredString(data.name, 'Team name');
    const memberIds = validateNonEmptyArray<string>(data.memberIds, 'memberIds');
    const teamAdminId = validateRequiredString(data.adminId, 'adminId');

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

    // Send notifications to all team members
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
 * Super Admin or Team Admin can call this function
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

    const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
    if (!teamDoc.exists) {
      throw new HttpsError('not-found', 'Team not found');
    }

    const team = teamDoc.data()!;
    const callerRole = context.auth?.token?.role;
    const isSuperAdmin = callerRole === UserRole.SUPER_ADMIN;
    const isTeamAdmin = team.adminId === callerId;

    if (!(isSuperAdmin || isTeamAdmin)) {
      throw new HttpsError(
        'permission-denied',
        'Only Super Admin or Team Admin can update this team'
      );
    }

    const batch = db.batch();
    const updateData: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: callerId,
    };

    // Handle name update
    if (updates.name !== undefined) {
      updateData.name = validateRequiredString(updates.name, 'Team name');
    }

    // Handle adminId update
    if (updates.adminId !== undefined) {
      const newAdminId = validateRequiredString(updates.adminId, 'adminId');
      const currentMembers = updates.memberIds || team.memberIds;

      if (!currentMembers.includes(newAdminId)) {
        throw new HttpsError(
          'invalid-argument',
          'New admin must be a team member'
        );
      }

      updateData.adminId = newAdminId;
    }

    // Handle members update
    if (updates.memberIds !== undefined) {
      const newMemberIds = validateNonEmptyArray<string>(updates.memberIds, 'memberIds');
      const oldMemberIds: string[] = team.memberIds;

      // Validate new admin is in new members list
      const finalAdminId = updates.adminId || team.adminId;
      if (finalAdminId && !newMemberIds.includes(finalAdminId)) {
        throw new HttpsError(
          'invalid-argument',
          'Team admin must remain in the members list'
        );
      }

      // Find added and removed members
      const addedMembers = newMemberIds.filter((id) => !oldMemberIds.includes(id));
      const removedMembers = oldMemberIds.filter((id) => !newMemberIds.includes(id));

      // Update added members' teamIds
      for (const memberId of addedMembers) {
        batch.update(db.collection(Collections.USERS).doc(memberId), {
          teamIds: admin.firestore.FieldValue.arrayUnion(teamId),
        });
      }

      // Update removed members' teamIds
      for (const memberId of removedMembers) {
        batch.update(db.collection(Collections.USERS).doc(memberId), {
          teamIds: admin.firestore.FieldValue.arrayRemove(teamId),
        });
      }

      updateData.memberIds = newMemberIds;

      // Send notifications
      if (addedMembers.length > 0) {
        await sendMulticastNotification(
          addedMembers,
          '👥 Team Update',
          `Added to ${updates.name || team.name}`,
          createNotificationData(NotificationType.MEMBER_ADDED, { teamId })
        );
      }

      if (removedMembers.length > 0) {
        await sendMulticastNotification(
          removedMembers,
          '👥 Team Update',
          `Removed from ${team.name}`,
          createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
        );
      }
    }

    batch.update(db.collection(Collections.TEAMS).doc(teamId), updateData);
    await batch.commit();

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

    validateSuperAdmin(context);
    const teamId = validateRequiredString(data.teamId, 'teamId');

    const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
    if (!teamDoc.exists) {
      throw new HttpsError('not-found', 'Team not found');
    }

    const team = teamDoc.data()!;
    const memberIds: string[] = team.memberIds;

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

    // Notify members
    await sendMulticastNotification(
      memberIds,
      '🗑️ Team Deleted',
      `${team.name} has been dissolved`,
      createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
    );

    return { success: true, message: 'Team deleted successfully' };
  }
);
