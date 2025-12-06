import * as functions from 'firebase-functions';
import { admin, db, auth } from '../config/firebase-admin';
import { Collections, UserRole, UserStatus, TaskStatus, NotificationType } from '../config/constants';
import {
  validateSuperAdminAsync,
  validateRequiredString,
  validateRole,
} from '../utils/validators';
import {
  sendNotification,
  createNotificationData,
} from '../services/notificationService';
import {
  ApproveUserInput,
  RejectUserInput,
  UpdateUserRoleInput,
  RevokeUserInput,
  DeleteUserInput,
} from '../types';

/**
 * Approve a pending user's access request
 * Only Super Admin can call this function
 */
export const approveUserAccess = functions.region('asia-south1').https.onCall(
  async (data: ApproveUserInput, context) => {
    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.PENDING) {
      throw new functions.https.HttpsError(
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

    // Send notification to the approved user
    await sendNotification(
      userId,
      '✅ Welcome Aboard!',
      'Your account is now active',
      createNotificationData(NotificationType.APPROVAL_GRANTED, { userId })
    );

    return { success: true, message: 'User approved successfully' };
  }
);

/**
 * Reject a pending user's access request
 * Only Super Admin can call this function
 */
export const rejectUserAccess = functions.region('asia-south1').https.onCall(
  async (data: RejectUserInput, context) => {
    await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');
    const reason = data.reason;

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.PENDING) {
      throw new functions.https.HttpsError(
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
export const updateUserRole = functions.region('asia-south1').https.onCall(
  async (data: UpdateUserRoleInput, context) => {
    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');
    const newRole = validateRole(data.newRole);

    // Prevent changing own role
    if (userId === adminId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Cannot change your own role'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
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
    const roleDisplay = newRole === 'super_admin' ? 'Super Admin' : 
                        newRole === 'team_admin' ? 'Team Admin' : 'Member';
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
export const revokeUserAccess = functions.region('asia-south1').https.onCall(
  async (data: RevokeUserInput, context) => {
    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    // Prevent revoking own access
    if (userId === adminId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Cannot revoke your own access'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    // Update user status to revoked
    await db.collection(Collections.USERS).doc(userId).update({
      status: UserStatus.REVOKED,
      revokedBy: adminId,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Disable Firebase Auth account
    await auth.updateUser(userId, { disabled: true });

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
export const restoreUserAccess = functions.region('asia-south1').https.onCall(
  async (data: { userId: string }, context) => {
    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.status !== UserStatus.REVOKED) {
      throw new functions.https.HttpsError(
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

    // Re-enable Firebase Auth account
    await auth.updateUser(userId, { disabled: false });

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
export const deleteUser = functions.region('asia-south1').https.onCall(
  async (data: DeleteUserInput, context) => {
    const adminId = await validateSuperAdminAsync(context);
    const userId = validateRequiredString(data.userId, 'userId');

    // Prevent deleting own account
    if (userId === adminId) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Cannot delete your own account'
      );
    }

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
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

    // 3. Delete user document
    batch.delete(db.collection(Collections.USERS).doc(userId));

    await batch.commit();

    // 4. Delete Firebase Auth account
    try {
      await auth.deleteUser(userId);
    } catch (error) {
      console.error(`Failed to delete auth account for ${userId}:`, error);
    }

    return { success: true, message: 'User deleted successfully' };
  }
);

/**
 * Update user's own profile (name, avatar, notification preferences)
 * Any authenticated user can update their own profile
 */
export const updateProfile = functions.region('asia-south1').https.onCall(
  async (data: { name?: string; avatarUrl?: string; notificationPreferences?: Record<string, boolean> }, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Must be authenticated to update profile'
      );
    }

    const userId = context.auth.uid;
    const updates: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Validate and add name if provided
    if (data.name !== undefined) {
      const trimmedName = data.name.trim();
      if (trimmedName.length < 2 || trimmedName.length > 50) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          'Name must be between 2 and 50 characters'
        );
      }
      updates.name = trimmedName;
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
      throw new functions.https.HttpsError(
        'invalid-argument',
        'No valid updates provided'
      );
    }

    await db.collection(Collections.USERS).doc(userId).update(updates);

    return { success: true, message: 'Profile updated successfully' };
  }
);
