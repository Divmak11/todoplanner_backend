import * as functions from 'firebase-functions';
import { Collections, UserStatus, NotificationType } from '../config/constants';
import {
  sendNotification,
  sendMulticastNotification,
  notifySuperAdmins,
  createNotificationData,
} from '../services/notificationService';

/**
 * Trigger: Notify Super Admins when a new pending user is created
 */
export const notifyAdminNewUser = functions.region('asia-south1').firestore
  .document(`${Collections.USERS}/{userId}`)
  .onCreate(async (snap, context) => {
    const newUser = snap.data();

    // Only notify for pending users
    if (newUser.status !== UserStatus.PENDING) return;

    await notifySuperAdmins(
      '👤 Access Request',
      'A new user is awaiting approval',
      createNotificationData(NotificationType.NEW_PENDING_USER, {
        userId: context.params.userId,
      })
    );
  });

/**
 * Trigger: Notify user when their status changes
 */
export const notifyUserStatusChange = functions.region('asia-south1').firestore
  .document(`${Collections.USERS}/{userId}`)
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const userId = context.params.userId;

    // Check if status changed from pending to active
    if (before.status === UserStatus.PENDING && after.status === UserStatus.ACTIVE) {
      await sendNotification(
        userId,
        '✅ Welcome Aboard!',
        'Your account is now active',
        createNotificationData(NotificationType.APPROVAL_GRANTED)
      );
    }

    // Check if status changed to revoked
    if (before.status !== UserStatus.REVOKED && after.status === UserStatus.REVOKED) {
      await sendNotification(
        userId,
        '🚫 Access Suspended',
        'Contact admin for details',
        createNotificationData(NotificationType.APPROVAL_REJECTED)
      );
    }
  });

/**
 * Trigger: Notify when a new team is created
 */
export const notifyTeamCreation = functions.region('asia-south1').firestore
  .document(`${Collections.TEAMS}/{teamId}`)
  .onCreate(async (snap, context) => {
    const team = snap.data();
    const memberIds: string[] = team.memberIds || [];

    if (memberIds.length === 0) return;

    await sendMulticastNotification(
      memberIds,
      '👥 Team Update',
      `Added to ${team.name}`,
      createNotificationData(NotificationType.TEAM_CREATED, {
        teamId: context.params.teamId,
      })
    );
  });

/**
 * Trigger: Notify when team members change
 */
export const notifyTeamMemberChange = functions.region('asia-south1').firestore
  .document(`${Collections.TEAMS}/{teamId}`)
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const teamId = context.params.teamId;

    const oldMembers: string[] = before.memberIds || [];
    const newMembers: string[] = after.memberIds || [];

    // Find added members
    const addedMembers = newMembers.filter((id) => !oldMembers.includes(id));
    // Find removed members
    const removedMembers = oldMembers.filter((id) => !newMembers.includes(id));

    if (addedMembers.length > 0) {
      await sendMulticastNotification(
        addedMembers,
        '👥 Team Update',
        `Added to ${after.name}`,
        createNotificationData(NotificationType.MEMBER_ADDED, { teamId })
      );
    }

    if (removedMembers.length > 0) {
      await sendMulticastNotification(
        removedMembers,
        '👥 Team Update',
        `Removed from ${before.name}`,
        createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
      );
    }
  });

/**
 * Trigger: Notify when a new task is created
 */
export const notifyTaskAssignment = functions.region('asia-south1').firestore
  .document(`${Collections.TASKS}/{taskId}`)
  .onCreate(async (snap, context) => {
    const task = snap.data();
    const taskId = context.params.taskId;

    // Format deadline
    const deadline = task.deadline?.toDate();
    const deadlineStr = deadline ? deadline.toLocaleDateString() : 'No deadline';

    await sendNotification(
      task.assignedTo,
      '📋 New Task',
      `"${task.title}" • Due ${deadlineStr}`,
      createNotificationData(NotificationType.TASK_ASSIGNED, { taskId })
    );
  });

/**
 * Trigger: Notify when task status changes
 */
export const notifyTaskStatusChange = functions.region('asia-south1').firestore
  .document(`${Collections.TASKS}/{taskId}`)
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const taskId = context.params.taskId;

    // Status didn't change
    if (before.status === after.status) return;

    // Task completed - notify creator
    if (after.status === 'completed' && before.status === 'ongoing') {
      if (after.createdBy !== after.assignedTo) {
        await sendNotification(
          after.createdBy,
          '✅ Task Done',
          `"${after.title}" completed`,
          createNotificationData(NotificationType.TASK_COMPLETED, { taskId })
        );
      }
    }

    // Task cancelled - notify assignee
    if (after.status === 'cancelled' && before.status === 'ongoing') {
      if (after.createdBy !== after.assignedTo) {
        await sendNotification(
          after.assignedTo,
          '❌ Task Cancelled',
          `"${after.title}" was cancelled`,
          createNotificationData(NotificationType.TASK_CANCELLED, { taskId })
        );
      }
    }
  });
