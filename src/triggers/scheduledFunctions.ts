import { onSchedule } from 'firebase-functions/v2/scheduler';
import { admin, db } from '../config/firebase-admin';
import { Collections, TaskStatus, NotificationType } from '../config/constants';
import {
  sendNotification,
  notifySuperAdmins,
  createNotificationData,
} from '../services/notificationService';

// 2nd Gen configuration for scheduled functions
const scheduleConfig = { region: 'asia-south1', timeZone: 'Asia/Kolkata' };

/**
 * Scheduled function: Check for upcoming deadlines and send reminders
 * Runs every 4 hours (optimized from hourly to reduce costs)
 * Window widened to 20-24 hours to ensure no tasks are missed
 */
export const checkDeadlines = onSchedule(
  { schedule: 'every 4 hours', ...scheduleConfig },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const nowMs = now.toMillis();

    // Define time window for 24-hour reminder
    const oneDayMs = 24 * 60 * 60 * 1000;
    const fourHoursMs = 4 * 60 * 60 * 1000; // Check window matches execution frequency

    // Get all ongoing tasks
    const ongoingTasks = await db.collection(Collections.TASKS)
      .where('status', '==', TaskStatus.ONGOING)
      .get();

    // Process tasks in parallel batches for better performance
    const reminderPromises: Promise<void>[] = [];

    for (const doc of ongoingTasks.docs) {
      const task = doc.data();
      const taskId = doc.id;
      const deadlineMs = task.deadline?.toMillis();

      if (!deadlineMs) continue;

      const timeUntilDeadline = deadlineMs - nowMs;

      // 24-hour reminder (between 20-24 hours before deadline)
      // Wider window ensures no tasks are missed with 4-hour check frequency
      if (timeUntilDeadline > oneDayMs - fourHoursMs && timeUntilDeadline <= oneDayMs) {
        reminderPromises.push(sendDeadlineReminder(taskId, task));
      }
    }

    // Execute all reminders in parallel
    await Promise.all(reminderPromises);

    console.log(`Deadline check completed. Processed ${ongoingTasks.size} tasks.`);
  }
);

/**
 * Helper: Send 24-hour deadline reminder to assignee and creator
 * Only sends FCM push to users without calendar connected (calendar handles reminders for connected users)
 * Always logs to Activity for all users
 */
async function sendDeadlineReminder(
  taskId: string,
  task: admin.firestore.DocumentData
): Promise<void> {
  // Handle multi-assignee tasks
  if (task.isMultiAssignee && task.assigneeIds?.length > 0) {
    const assigneeIds: string[] = task.assigneeIds;
    for (const assigneeId of assigneeIds) {
      await sendConditionalDeadlineReminder(assigneeId, taskId, task.title, false);
    }
  } else if (task.assignedTo) {
    // Single-assignee task
    await sendConditionalDeadlineReminder(task.assignedTo, taskId, task.title, false);
  }

  // Notify creator (if different from all assignees)
  const allAssignees = task.isMultiAssignee ? (task.assigneeIds || []) : [task.assignedTo];
  if (task.createdBy && !allAssignees.includes(task.createdBy)) {
    await sendConditionalDeadlineReminder(task.createdBy, taskId, task.title, true);
  }
}

/**
 * Helper: Send deadline reminder conditionally based on calendar connection
 * - Always logs to Activity (Firestore notifications collection)
 * - Only sends FCM push if user has no calendar connected
 */
async function sendConditionalDeadlineReminder(
  userId: string,
  taskId: string,
  taskTitle: string,
  isCreator: boolean
): Promise<void> {
  // Check if user has calendar connected
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();
  const hasCalendar = user?.googleCalendarConnected === true;

  const title = '⏰ Due Tomorrow';
  const body = isCreator ? `"${taskTitle}" assigned to team member` : `"${taskTitle}"`;
  const data = createNotificationData(NotificationType.TASK_OVERDUE, { taskId });

  if (hasCalendar) {
    // User has calendar - only log to Activity, skip FCM (calendar handles reminders)
    await db.collection('notifications').add({
      userId,
      type: NotificationType.TASK_OVERDUE,
      title,
      message: body,
      taskId,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Activity log saved for calendar user ${userId} (FCM skipped)`);
  } else {
    // No calendar - send full notification (Activity + FCM)
    await sendNotification(userId, title, body, data);
  }
}

/**
 * Scheduled function: Check for overdue tasks
 * Runs daily at 9 AM
 */
export const checkOverdueTasks = onSchedule(
  { schedule: '0 9 * * *', ...scheduleConfig },
  async () => {
    const now = admin.firestore.Timestamp.now();

    // Get all overdue ongoing tasks
    const overdueTasks = await db.collection(Collections.TASKS)
      .where('status', '==', TaskStatus.ONGOING)
      .where('deadline', '<', now)
      .get();

    if (overdueTasks.empty) {
      console.log('No overdue tasks found.');
      return;
    }

    // Group tasks by assignee, creator, and team admin for summary notifications
    const tasksByAssignee: Map<string, string[]> = new Map();
    const tasksByCreator: Map<string, string[]> = new Map();
    const tasksByTeamAdmin: Map<string, string[]> = new Map();
    const allOverdueTasks: string[] = [];

    // Get all teams for team admin lookup
    const teamsSnapshot = await db.collection(Collections.TEAMS).get();
    const teamAdminByMember: Map<string, string> = new Map();
    teamsSnapshot.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const team = doc.data();
      const adminId = team.adminId;
      const memberIds: string[] = team.memberIds || [];
      if (adminId) {
        memberIds.forEach((memberId: string) => {
          if (memberId !== adminId) {
            teamAdminByMember.set(memberId, adminId);
          }
        });
      }
    });

    for (const doc of overdueTasks.docs) {
      const task = doc.data();

      // Group by assignee
      const assigneeTasks = tasksByAssignee.get(task.assignedTo) || [];
      assigneeTasks.push(task.title);
      tasksByAssignee.set(task.assignedTo, assigneeTasks);

      // Group by creator
      if (task.createdBy !== task.assignedTo) {
        const creatorTasks = tasksByCreator.get(task.createdBy) || [];
        creatorTasks.push(task.title);
        tasksByCreator.set(task.createdBy, creatorTasks);
      }

      // Group by team admin (if assignee is a team member)
      const teamAdminId = teamAdminByMember.get(task.assignedTo);
      if (teamAdminId && teamAdminId !== task.createdBy && teamAdminId !== task.assignedTo) {
        const adminTasks = tasksByTeamAdmin.get(teamAdminId) || [];
        adminTasks.push(task.title);
        tasksByTeamAdmin.set(teamAdminId, adminTasks);
      }

      allOverdueTasks.push(task.title);
    }

    // Send notifications to assignees
    for (const [assigneeId, tasks] of tasksByAssignee) {
      const count = tasks.length;
      await sendNotification(
        assigneeId,
        `🔴 ${count} Overdue`,
        count === 1 ? `"${tasks[0]}"` : `${count} tasks need attention`,
        createNotificationData(NotificationType.TASK_OVERDUE)
      );
    }

    // Send notifications to creators
    for (const [creatorId, tasks] of tasksByCreator) {
      const count = tasks.length;
      await sendNotification(
        creatorId,
        `📊 Tasks Overdue`,
        count === 1 ? `"${tasks[0]}"` : `${count} assigned tasks past deadline`,
        createNotificationData(NotificationType.TASK_OVERDUE)
      );
    }

    // Send notifications to team admins
    for (const [adminId, tasks] of tasksByTeamAdmin) {
      const count = tasks.length;
      await sendNotification(
        adminId,
        `👥 Team Tasks Overdue`,
        count === 1 ? `"${tasks[0]}"` : `${count} team member tasks past deadline`,
        createNotificationData(NotificationType.TASK_OVERDUE)
      );
    }

    // Notify Super Admins with summary
    if (allOverdueTasks.length > 0) {
      await notifySuperAdmins(
        '📊 Daily Report',
        `${allOverdueTasks.length} overdue task${allOverdueTasks.length > 1 ? 's' : ''} across team`,
        createNotificationData(NotificationType.TASK_OVERDUE)
      );
    }

    console.log(`Overdue check completed. Found ${overdueTasks.size} overdue tasks.`);
  }
);

/**
 * Scheduled function: Daily cleanup
 * Runs daily at midnight
 */
export const cleanupInactiveTracking = onSchedule(
  { schedule: '0 0 * * *', ...scheduleConfig },
  async () => {
    // This is a placeholder for any cleanup tasks
    // Could be used to archive old data, clean up orphaned records, etc.
    console.log('Daily cleanup completed.');
  }
);
/**
 * Scheduled function: Maintain Google Calendar tokens
 * Runs on the 1st of every month at 3 AM to proactively refresh tokens
 * and detect revoked access before users experience failures.
 */
export const maintainCalendarTokens = onSchedule(
  { schedule: '0 3 1 * *', ...scheduleConfig }, // 3 AM on 1st of month
  async () => {
    console.log('🔄 [CALENDAR_MAINTENANCE] Starting monthly token check...');

    const usersWithCalendar = await db.collection(Collections.USERS)
      .where('googleCalendarConnected', '==', true)
      .get();

    let refreshedCount = 0;
    let revokedCount = 0;
    let errorCount = 0;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('🔄 [CALENDAR_MAINTENANCE] Missing OAuth credentials, aborting');
      return;
    }

    // Import google auth dynamically to avoid circular dependencies
    const { google } = await import('googleapis');

    for (const userDoc of usersWithCalendar.docs) {
      const userId = userDoc.id;
      const user = userDoc.data();

      if (!user.googleRefreshToken) {
        console.log(`🔄 [CALENDAR_MAINTENANCE] Skipping ${userId} - no refresh token`);
        continue;
      }

      try {
        // Attempt to refresh the token
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, '');
        oauth2Client.setCredentials({ refresh_token: user.googleRefreshToken });
        const { credentials } = await oauth2Client.refreshAccessToken();

        if (credentials.access_token) {
          await userDoc.ref.update({ googleAccessToken: credentials.access_token });
          refreshedCount++;
          console.log(`✅ [CALENDAR_MAINTENANCE] Refreshed token for ${userId}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('invalid_grant') || msg.includes('revoked')) {
          // Token was revoked externally
          await userDoc.ref.update({
            googleCalendarConnected: false,
            googleRefreshToken: admin.firestore.FieldValue.delete(),
            googleAccessToken: admin.firestore.FieldValue.delete(),
          });
          revokedCount++;
          console.log(`⚠️ [CALENDAR_MAINTENANCE] Token revoked for ${userId}`);

          // Notify user about revocation
          await sendNotification(
            userId,
            '🔄 Calendar Reconnection Required',
            'Your calendar connection expired. Please reconnect in Settings.',
            createNotificationData(NotificationType.TASK_UPDATED, { action: 'calendar_reconnect' })
          );
        } else {
          errorCount++;
          console.error(`❌ [CALENDAR_MAINTENANCE] Error for ${userId}:`, msg);
        }
      }
    }

    console.log(`🔄 [CALENDAR_MAINTENANCE] Complete. Refreshed: ${refreshedCount}, Revoked: ${revokedCount}, Errors: ${errorCount}`);
  }
);
