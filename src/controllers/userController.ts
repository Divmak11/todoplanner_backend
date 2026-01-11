import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { admin, db, auth } from '../config/firebase-admin';
import { Collections, UserRole, UserStatus, TaskStatus, NotificationType } from '../config/constants';
import {
  validateSuperAdminAsync,
  validateRequiredString,
  validateRole,
  validateAuthenticated,
} from '../utils/validators';
import {
  sendNotification,
  createNotificationData,
} from '../services/notificationService';
import { deleteAllUserCalendarEvents } from '../services/calendarService';
import {
  ApproveUserInput,
  RejectUserInput,
  UpdateUserRoleInput,
  RevokeUserInput,
  DeleteUserInput,
} from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Approve a pending user's access request
 * Only Super Admin can call this function
 */
export const approveUserAccess = onCall(
  callableConfig,
  async (request: CallableRequest<ApproveUserInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        'User is not in pending status'
      );
    }

    // Update user status to active
    await db.collection(Collections.USERS).doc(userId).update({
      status: UserStatus.ACTIVE,
      approvedBy: adminId,
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Set custom claims for the user
    await auth.setCustomUserClaims(userId, { role: user.role });

    // Fire-and-forget: Send notification in background (don't block the response)
    sendNotification(
      userId,
      '✅ Welcome Aboard!',
      'Your account is now active',
      createNotificationData(NotificationType.APPROVAL_GRANTED, { userId })
    ).catch((error) => {
      console.error(`Failed to send approval notification to ${userId}:`, error);
    });

    return { success: true, message: 'User approved successfully' };
  }
);

/**
 * Reject a pending user's access request
 * Only Super Admin can call this function
 */
export const rejectUserAccess = onCall(
  callableConfig,
  async (request: CallableRequest<RejectUserInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');
    const reason = data.reason;

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        'User is not in pending status'
      );
    }

    // Send notification before deleting
    if (user.fcmToken) {
      await sendNotification(
        userId,
        '❌ Access Declined',
        reason || 'Contact admin for details',
        createNotificationData(NotificationType.APPROVAL_REJECTED, { userId })
      );
    }

    // Delete the user document
    await db.collection(Collections.USERS).doc(userId).delete();

    // Delete Firebase Auth account
    try {
      await auth.deleteUser(userId);
    } catch (error) {
      console.error(`Failed to delete auth account for ${userId}:`, error);
    }

    return { success: true, message: 'User rejected successfully' };
  }
);

/**
 * Update a user's role
 * Only Super Admin can call this function
 */
export const updateUserRole = onCall(
  callableConfig,
  async (request: CallableRequest<UpdateUserRoleInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');
    const newRole = validateRole(data.newRole);

    // Prevent changing own role
    if (userId === adminId) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot change your own role'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    const oldRole = user.role;

    if (oldRole === newRole) {
      return { success: true, message: 'Role unchanged' };
    }

    const batch = db.batch();

    // If user was Team Admin and is being demoted, clear adminId from their teams
    if (oldRole === UserRole.TEAM_ADMIN && newRole !== UserRole.TEAM_ADMIN) {
      const teamsSnapshot = await db
        .collection(Collections.TEAMS)
        .where('adminId', '==', userId)
        .get();

      teamsSnapshot.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
        batch.update(doc.ref, { adminId: null });
      });
    }

    // Update user role
    batch.update(db.collection(Collections.USERS).doc(userId), {
      role: newRole,
      roleUpdatedBy: adminId,
      roleUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // Update custom claims
    await auth.setCustomUserClaims(userId, { role: newRole });

    // Notify user of role change
    const roleDisplay =
      newRole === UserRole.SUPER_ADMIN ? 'Super Admin' :
        newRole === UserRole.TEAM_ADMIN ? 'Team Admin' :
          'Member';
    await sendNotification(
      userId,
      '🔄 Role Updated',
      `You are now a ${roleDisplay}`,
      createNotificationData(NotificationType.ROLE_CHANGED, { userId, newRole })
    );

    return { success: true, message: `Role updated to ${newRole}` };
  }
);

/**
 * Revoke a user's access (soft delete - disables account)
 * Only Super Admin can call this function
 */
export const revokeUserAccess = onCall(
  callableConfig,
  async (request: CallableRequest<RevokeUserInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    // Prevent revoking own access
    if (userId === adminId) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot revoke your own access'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    // Update user status to revoked
    await db.collection(Collections.USERS).doc(userId).update({
      status: UserStatus.REVOKED,
      revokedBy: adminId,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Disable Firebase Auth account - REMOVED to allow user to see "Access Revoked" screen
    // await auth.updateUser(userId, { disabled: true });

    // Notify user
    await sendNotification(
      userId,
      '🚫 Access Suspended',
      'Contact admin for details',
      createNotificationData(NotificationType.APPROVAL_REJECTED, { userId })
    );

    return { success: true, message: 'User access revoked' };
  }
);

/**
 * Restore a revoked user's access
 * Only Super Admin can call this function
 */
export const restoreUserAccess = onCall(
  callableConfig,
  async (request: CallableRequest<{ userId: string }>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.REVOKED) {
      throw new HttpsError(
        'failed-precondition',
        'User is not in revoked status'
      );
    }

    // Update user status to active
    await db.collection(Collections.USERS).doc(userId).update({
      status: UserStatus.ACTIVE,
      restoredBy: adminId,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Re-enable Firebase Auth account (handles legacy revoked users who have disabled accounts)
    // This is safe to call even if account is not disabled - it will just ensure it's enabled
    try {
      await auth.updateUser(userId, { disabled: false });
    } catch (error) {
      console.error(`Failed to re-enable auth account for ${userId}:`, error);
      // Continue anyway - Firestore status is updated, which is most important
    }

    // Notify user
    await sendNotification(
      userId,
      '✅ Welcome Back!',
      'Your access has been restored',
      createNotificationData(NotificationType.APPROVAL_GRANTED, { userId })
    );

    return { success: true, message: 'User access restored' };
  }
);

/**
 * Permanently delete a user and cleanup related data
 * Only Super Admin can call this function
 */
export const deleteUser = onCall(
  callableConfig,
  async (request: CallableRequest<DeleteUserInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    // Prevent deleting own account
    if (userId === adminId) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot delete your own account'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const batch = db.batch();

    // 1. Cancel all ongoing tasks assigned to user
    const assignedTasks = await db
      .collection(Collections.TASKS)
      .where('assignedTo', '==', userId)
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    assignedTasks.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      batch.update(doc.ref, {
        status: TaskStatus.CANCELLED,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 1.5. Handle multi-assignee tasks
    // Find tasks where this user is one of the assignees
    const multiAssigneeTasks = await db
      .collection(Collections.TASKS)
      .where('assigneeIds', 'array-contains', userId)
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    for (const doc of multiAssigneeTasks.docs) {
      const task = doc.data();
      const currentAssigneeIds: string[] = task.assigneeIds || [];
      const newAssigneeIds = currentAssigneeIds.filter((id) => id !== userId);

      if (newAssigneeIds.length === 0) {
        // If no assignees left, cancel the task
        batch.update(doc.ref, {
          status: TaskStatus.CANCELLED,
          cancelReason: 'All assignees deleted',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Just remove this user from assigneeIds
        batch.update(doc.ref, {
          assigneeIds: newAssigneeIds,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Mark their specific assignment as CANCELLED (or delete it)
      // We'll mark as CANCELLED to keep history if needed, or deleting is fine too.
      // Let's cancel it for now to avoid broken refs if referenced elsewhere.
      const assignmentsQuery = await doc.ref.collection(Collections.ASSIGNMENTS)
        .where('userId', '==', userId)
        .get();

      assignmentsQuery.docs.forEach(assignmentDoc => {
        batch.update(assignmentDoc.ref, {
          status: 'cancelled', // Using lowercase string or TaskAssignmentStatus.CANCELLED if guaranteed
          completedAt: admin.firestore.FieldValue.serverTimestamp(), // reusing completedAt or adding cancelledAt
          completionRemark: 'User account deleted'
        });
      });
    }

    // 2. Remove user from all teams
    const teamsSnapshot = await db
      .collection(Collections.TEAMS)
      .where('memberIds', 'array-contains', userId)
      .get();

    teamsSnapshot.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const team = doc.data();
      const memberIds = team.memberIds.filter((id: string) => id !== userId);
      const updates: Record<string, unknown> = { memberIds };

      // If user was admin, clear adminId
      if (team.adminId === userId) {
        updates.adminId = null;
      }

      batch.update(doc.ref, updates);
    });

    // 3. Clean up calendar events if user had calendar connected
    // IMPORTANT: Do this BEFORE deleting user doc so we can still fetch calendar data
    const user = userDoc.data()!;
    if (user.googleCalendarConnected) {
      try {
        console.log(`🗓️ Cleaning up calendar events for deleted user ${userId}`);
        await deleteAllUserCalendarEvents(userId);
        console.log(`✅ Calendar events cleaned up for ${userId}`);
      } catch (error) {
        console.error(`⚠️ Failed to clean up calendar events for ${userId}:`, error);
        // Continue with deletion even if calendar cleanup fails
      }
    }

    // 4. Delete user document
    batch.delete(db.collection(Collections.USERS).doc(userId));

    // 5. Archive to deleted_users (Audit Log)
    batch.set(db.collection('deleted_users').doc(userId), {
      ...user,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedBy: adminId, // Admin deleted
      deletionReason: 'Admin deleted',
      originalUserId: userId,
    });

    // 6. Clean up duplicates by email (The "Zombie" Killer)
    if (user.email) {
      const duplicatesSnapshot = await db
        .collection(Collections.USERS)
        .where('email', '==', user.email)
        .get();

      duplicatesSnapshot.docs.forEach((doc) => {
        if (doc.id !== userId) {
          console.log(`🗑️ Deleting duplicate/zombie user found for email ${user.email}: ${doc.id}`);
          batch.delete(doc.ref);
          // Also archive duplicates? Maybe not necessary, but good for completeness 
          // batch.set(db.collection('deleted_users').doc(doc.id), { ...doc.data(), deletedBy: 'System (Duplicate Cleanup)' });
        }
      });
    }

    await batch.commit();

    // 6. Delete Firebase Auth account
    try {
      await auth.deleteUser(userId);
    } catch (error) {
      console.error(`Failed to delete auth account for ${userId}:`, error);
    }

    return { success: true, message: 'User deleted successfully' };
  }
);

/**
 * Delete own account and all associated data
 * Any authenticated user can delete their own account (Play Store compliance)
 */
export const deleteOwnAccount = onCall(
  callableConfig,
  async (request: CallableRequest<unknown>) => {
    const context = { auth: request.auth };

    const userId = validateAuthenticated(context);

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;

    // Super admins cannot delete themselves (safety measure)
    if (user.role === UserRole.SUPER_ADMIN) {
      throw new HttpsError(
        'failed-precondition',
        'Super Admin accounts cannot be self-deleted. Contact another Super Admin.'
      );
    }

    const batch = db.batch();

    // 1. Cancel all ongoing tasks assigned to this user
    const assignedTasks = await db
      .collection(Collections.TASKS)
      .where('assignedTo', '==', userId)
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    assignedTasks.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      batch.update(doc.ref, {
        status: TaskStatus.CANCELLED,
        cancelReason: 'User account deleted',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // 1.5. Handle multi-assignee tasks
    // Find tasks where this user is one of the assignees
    const multiAssigneeTasks = await db
      .collection(Collections.TASKS)
      .where('assigneeIds', 'array-contains', userId)
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    for (const doc of multiAssigneeTasks.docs) {
      const task = doc.data();
      const currentAssigneeIds: string[] = task.assigneeIds || [];
      const newAssigneeIds = currentAssigneeIds.filter((id) => id !== userId);

      if (newAssigneeIds.length === 0) {
        // If no assignees left, cancel the task
        batch.update(doc.ref, {
          status: TaskStatus.CANCELLED,
          cancelReason: 'Last assignee deleted account',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Just remove this user from assigneeIds
        batch.update(doc.ref, {
          assigneeIds: newAssigneeIds,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Mark their specific assignment as CANCELLED
      const assignmentsQuery = await doc.ref.collection(Collections.ASSIGNMENTS)
        .where('userId', '==', userId)
        .get();

      assignmentsQuery.docs.forEach(assignmentDoc => {
        batch.update(assignmentDoc.ref, {
          status: 'cancelled',
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          completionRemark: 'User account deleted'
        });
      });
    }

    // 2. Remove user from all teams
    const teamsSnapshot = await db
      .collection(Collections.TEAMS)
      .where('memberIds', 'array-contains', userId)
      .get();

    teamsSnapshot.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const team = doc.data();
      const memberIds = team.memberIds.filter((id: string) => id !== userId);
      const updates: Record<string, unknown> = { memberIds };

      // If user was team admin, clear adminId
      if (team.adminId === userId) {
        updates.adminId = null;
      }

      batch.update(doc.ref, updates);
    });

    // 3. Delete user's notifications
    const notifications = await db
      .collection(Collections.NOTIFICATIONS)
      .where('userId', '==', userId)
      .get();

    notifications.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      batch.delete(doc.ref);
    });

    // 4. Delete user's remarks
    const remarks = await db
      .collection(Collections.REMARKS)
      .where('userId', '==', userId)
      .get();

    remarks.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      batch.delete(doc.ref);
    });

    // 5. Clean up calendar events if user had calendar connected
    // IMPORTANT: Do this BEFORE deleting user doc so we can still fetch calendar data
    if (user.googleCalendarConnected) {
      try {
        console.log(`🗓️ Cleaning up calendar events for self-deleting user ${userId}`);
        await deleteAllUserCalendarEvents(userId);
        console.log(`✅ Calendar events cleaned up for ${userId}`);
      } catch (error) {
        console.error(`⚠️ Failed to clean up calendar events for ${userId}:`, error);
        // Continue with deletion even if calendar cleanup fails
      }
    }

    // 6. Delete user document
    batch.delete(db.collection(Collections.USERS).doc(userId));

    // 7. Archive to deleted_users (Audit Log)
    batch.set(db.collection('deleted_users').doc(userId), {
      ...user,
      deletedAt: admin.firestore.FieldValue.serverTimestamp(),
      deletedBy: userId, // Self deleted
      deletionReason: 'User self-deleted',
      originalUserId: userId,
    });

    // 8. Clean up duplicates by email (The "Zombie" Killer)
    if (user.email) {
      const duplicatesSnapshot = await db
        .collection(Collections.USERS)
        .where('email', '==', user.email)
        .get();

      duplicatesSnapshot.docs.forEach((doc) => {
        if (doc.id !== userId) {
          console.log(`🗑️ Deleting duplicate/zombie user found for email ${user.email}: ${doc.id}`);
          batch.delete(doc.ref);
        }
      });
    }

    await batch.commit();

    // 9. Delete Firebase Auth account
    try {
      await auth.deleteUser(userId);
    } catch (error) {
      console.error(`Failed to delete auth account for ${userId}:`, error);
    }

    console.log(`✅ User ${userId} deleted their own account`);

    return { success: true, message: 'Account and data deleted successfully' };
  }
);

/**
 * Update user's own profile (name, avatar, notification preferences)
 * Any authenticated user can update their own profile
 */
interface UpdateProfileInput {
  name?: string;
  avatarUrl?: string;
  notificationPreferences?: Record<string, boolean>;
}

export const updateProfile = onCall(
  callableConfig,
  async (request: CallableRequest<UpdateProfileInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const userId = validateAuthenticated(context);

    const updates: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Validate and add name if provided
    if (data.name !== undefined) {
      const trimmedName = data.name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 50) {
        throw new HttpsError(
          'invalid-argument',
          'Name must be between 2 and 50 characters'
        );
      }
      updates.name = trimmedName;
      updates.needsOnboarding = false; // Mark onboarding as complete when name is set
    }

    // Add avatar URL if provided
    if (data.avatarUrl !== undefined) {
      updates.avatarUrl = data.avatarUrl;
    }

    // Add notification preferences if provided
    if (data.notificationPreferences !== undefined) {
      updates.notificationPreferences = data.notificationPreferences;
    }

    // Check if there are any updates to make
    if (Object.keys(updates).length === 1) {
      throw new HttpsError(
        'invalid-argument',
        'No valid updates provided'
      );
    }

    await db.collection(Collections.USERS).doc(userId).update(updates);

    return { success: true, message: 'Profile updated successfully' };
  }
);
