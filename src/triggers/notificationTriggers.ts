import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Collections, UserStatus, NotificationType } from '../config/constants';
import {
  sendNotification,
  sendMulticastNotification,
  notifySuperAdmins,
  createNotificationData,
} from '../services/notificationService';

// 2nd Gen configuration for Firestore triggers
const triggerConfig = { region: 'asia-south1' };

/**
 * Helper: Send task assignment notification
 * ALWAYS sends FCM push notification regardless of calendar status.
 * Calendar events are supplementary, not a replacement for push notifications.
 */
async function sendConditionalAssignmentNotification(
  userId: string,
  title: string,
  body: string,
  taskId: string
): Promise<void> {
  // Always send full notification (Activity + FCM)
  // Even if user has calendar connected, they should get push notification
  // Calendar events are async and user might not be checking calendar
  await sendNotification(
    userId,
    title,
    body,
    createNotificationData(NotificationType.TASK_ASSIGNED, { taskId })
  );
}

/**
 * Trigger: Notify Super Admins when a new pending user is created
 */
export const notifyAdminNewUser = onDocumentCreated(
  { document: `${Collections.USERS}/{userId}`, ...triggerConfig },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const newUser = snap.data();
    const userId = event.params.userId;

    // Only notify for pending users
    if (newUser.status !== UserStatus.PENDING) return;

    await notifySuperAdmins(
      'Access Request',
      'New user awaiting approval',
      createNotificationData(NotificationType.NEW_PENDING_USER, { userId })
    );
  }
);

/**
 * Trigger: Notify user when their status changes
 */
export const notifyUserStatusChange = onDocumentUpdated(
  { document: `${Collections.USERS}/{userId}`, ...triggerConfig },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const userId = event.params.userId;

    // Check if status changed from pending to active
    if (before.status === UserStatus.PENDING && after.status === UserStatus.ACTIVE) {
      await sendNotification(
        userId,
        'Account Active',
        'Your access is now approved',
        createNotificationData(NotificationType.APPROVAL_GRANTED)
      );
    }

    // Check if status changed to revoked
    if (before.status !== UserStatus.REVOKED && after.status === UserStatus.REVOKED) {
      await sendNotification(
        userId,
        'Access Revoked',
        'Contact admin for support',
        createNotificationData(NotificationType.APPROVAL_REJECTED)
      );
    }
  }
);

/**
 * Trigger: Notify when a new team is created
 */
export const notifyTeamCreation = onDocumentCreated(
  { document: `${Collections.TEAMS}/{teamId}`, ...triggerConfig },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const team = snap.data();
    const teamId = event.params.teamId;
    const memberIds: string[] = team.memberIds || [];

    if (memberIds.length === 0) return;

    await sendMulticastNotification(
      memberIds,
      'Team Update',
      `Added to team "${team.name}"`,
      createNotificationData(NotificationType.TEAM_CREATED, { teamId })
    );
  }
);

/**
 * Trigger: Notify when team members change
 */
export const notifyTeamMemberChange = onDocumentUpdated(
  { document: `${Collections.TEAMS}/{teamId}`, ...triggerConfig },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const teamId = event.params.teamId;

    const oldMembers: string[] = before.memberIds || [];
    const newMembers: string[] = after.memberIds || [];

    // Find added members
    const addedMembers = newMembers.filter((id) => !oldMembers.includes(id));
    // Find removed members
    const removedMembers = oldMembers.filter((id) => !newMembers.includes(id));

    if (addedMembers.length > 0) {
      await sendMulticastNotification(
        addedMembers,
        'Team Update',
        `Added to team "${after.name}"`,
        createNotificationData(NotificationType.MEMBER_ADDED, { teamId })
      );
    }

    if (removedMembers.length > 0) {
      await sendMulticastNotification(
        removedMembers,
        'Team Update',
        `Removed from team "${before.name}"`,
        createNotificationData(NotificationType.MEMBER_REMOVED, { teamId })
      );
    }
  }
);

/**
 * Trigger: Notify when a new task is created
 * Handles both single-assignee and multi-assignee tasks
 * Uses conditional notification: Calendar users get Activity log only (calendar shows event)
 * Non-calendar users get full notification (Activity + FCM)
 */
export const notifyTaskAssignment = onDocumentCreated(
  { document: `${Collections.TASKS}/{taskId}`, ...triggerConfig },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const task = snap.data();
    const taskId = event.params.taskId;

    // Format deadline
    const deadline = task.deadline?.toDate();
    const deadlineStr = deadline ? deadline.toLocaleDateString() : 'No deadline';

    const title = 'Task Assigned';
    const body = `"${task.title}" • Due ${deadlineStr}`;

    // Handle multi-assignee tasks with conditional notifications
    if (task.isMultiAssignee && task.assigneeIds?.length > 0) {
      const assigneeIds: string[] = task.assigneeIds;
      const notificationPromises = assigneeIds.map((userId) =>
        sendConditionalAssignmentNotification(userId, title, body, taskId)
      );
      await Promise.all(notificationPromises);
    } else if (task.assignedTo) {
      // Single-assignee task with conditional notification
      await sendConditionalAssignmentNotification(task.assignedTo, title, body, taskId);
    }
  }
);

/**
 * Trigger: Notify when task status changes
 */
export const notifyTaskStatusChange = onDocumentUpdated(
  { document: `${Collections.TASKS}/{taskId}`, ...triggerConfig },
  async (event) => {
    const change = event.data;
    if (!change) return;

    const before = change.before.data();
    const after = change.after.data();
    const taskId = event.params.taskId;

    // Status didn't change
    if (before.status === after.status) return;

    // Task completed - notify creator
    if (after.status === 'completed' && before.status === 'ongoing') {
      await sendNotification(
        after.createdBy,
        'Task Completed',
        `"${after.title}" marked done`,
        createNotificationData(NotificationType.TASK_COMPLETED, { taskId })
      );
    }

    // Task cancelled - notify assignee(s)
    if (after.status === 'cancelled' && before.status === 'ongoing') {
      const cancelTitle = 'Task Cancelled';
      const cancelBody = `"${after.title}" was cancelled`;

      if (after.isMultiAssignee && after.assigneeIds?.length > 0) {
        const assigneeIds: string[] = after.assigneeIds;
        const notificationPromises = assigneeIds.map((userId) => {
          if (userId === after.createdBy) return Promise.resolve();
          return sendNotification(
            userId,
            cancelTitle,
            cancelBody,
            createNotificationData(NotificationType.TASK_CANCELLED, { taskId })
          );
        });
        await Promise.all(notificationPromises);
      } else if (after.assignedTo && after.createdBy !== after.assignedTo) {
        await sendNotification(
          after.assignedTo,
          cancelTitle,
          cancelBody,
          createNotificationData(NotificationType.TASK_CANCELLED, { taskId })
        );
      }
    }
  }
);
