import * as functions from 'firebase-functions';
import { admin, db } from '../config/firebase-admin';
import { Collections, TaskStatus, AssignmentType, UserRole, NotificationType } from '../config/constants';
import {
  validateAuthenticated,
  validateRequiredString,
  validateFutureDate,
  validateOptionalString,
} from '../utils/validators';
import {
  sendNotification,
  createNotificationData,
} from '../services/notificationService';
import { createCalendarEventForUser, updateCalendarEvent, deleteCalendarEvent } from '../services/calendarService';
import {
  AssignTaskInput,
  UpdateTaskInput,
  CompleteTaskInput,
  CancelTaskInput,
  ReopenTaskInput,
} from '../types';

/**
 * Assign a new task to a member or team
 */
export const assignTask = functions.region('asia-south1').https.onCall(
  async (data: AssignTaskInput, context: functions.https.CallableContext) => {
    const createdBy = validateAuthenticated(context);
    const title = validateRequiredString(data.title, 'Title');
    const subtitle = data.subtitle || '';
    const assignedType = data.assignedType;
    const assignedTo = validateRequiredString(data.assignedTo, 'assignedTo');
    const deadline = validateFutureDate(data.deadline, 'Deadline');

    if (assignedType !== AssignmentType.MEMBER && assignedType !== AssignmentType.TEAM) {
      throw new functions.https.HttpsError('invalid-argument', 'assignedType must be "member" or "team"');
    }

    const deadlineTimestamp = admin.firestore.Timestamp.fromDate(deadline);

    if (assignedType === AssignmentType.TEAM) {
      const teamDoc = await db.collection(Collections.TEAMS).doc(assignedTo).get();
      if (!teamDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'Team not found');
      }

      const team = teamDoc.data()!;
      const memberIds: string[] = team.memberIds;

      if (memberIds.length === 0) {
        throw new functions.https.HttpsError('failed-precondition', 'Team has no members');
      }

      const batch = db.batch();
      const taskIds: string[] = [];

      for (const memberId of memberIds) {
        const taskRef = db.collection(Collections.TASKS).doc();
        batch.set(taskRef, {
          title,
          subtitle,
          assignedType: AssignmentType.MEMBER,
          assignedTo: memberId,
          createdBy,
          status: TaskStatus.ONGOING,
          deadline: deadlineTimestamp,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        taskIds.push(taskRef.id);
      }

      await batch.commit();

      // Create calendar events in parallel (notifications handled by Firestore trigger)
      const calendarPromises = memberIds.map((memberId, index) =>
        createCalendarEventForUser(memberId, taskIds[index], title, subtitle, deadline)
      );
      await Promise.all(calendarPromises);

      return { success: true, taskIds };
    } else {
      const memberDoc = await db.collection(Collections.USERS).doc(assignedTo).get();
      if (!memberDoc.exists) {
        throw new functions.https.HttpsError('not-found', 'User not found');
      }

      const taskRef = await db.collection(Collections.TASKS).add({
        title,
        subtitle,
        assignedType: AssignmentType.MEMBER,
        assignedTo,
        createdBy,
        status: TaskStatus.ONGOING,
        deadline: deadlineTimestamp,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Create calendar event (notification handled by Firestore trigger)
      await createCalendarEventForUser(assignedTo, taskRef.id, title, subtitle, deadline);

      return { success: true, taskId: taskRef.id };
    }
  }
);

/**
 * Update a task (title, subtitle, deadline)
 */
export const updateTask = functions.region('asia-south1').https.onCall(
  async (data: UpdateTaskInput, context: functions.https.CallableContext) => {
    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const updates = data.updates;

    if (!updates || Object.keys(updates).length === 0) {
      throw new functions.https.HttpsError('invalid-argument', 'No updates provided');
    }

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;
    const callerRole = context.auth?.token?.role;
    const isSuperAdmin = callerRole === UserRole.SUPER_ADMIN;
    const isCreator = task.createdBy === callerId;

    if (!(isSuperAdmin || isCreator)) {
      throw new functions.https.HttpsError('permission-denied', 'Only task creator or Super Admin can update');
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new functions.https.HttpsError('failed-precondition', 'Can only update ongoing tasks');
    }

    const updateData: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (updates.title !== undefined) {
      updateData.title = validateRequiredString(updates.title, 'Title');
    }

    if (updates.subtitle !== undefined) {
      updateData.subtitle = updates.subtitle || '';
    }

    if (updates.deadline !== undefined) {
      const newDeadline = validateFutureDate(updates.deadline, 'Deadline');
      updateData.deadline = admin.firestore.Timestamp.fromDate(newDeadline);

      if (task.calendarEventId) {
        await updateCalendarEvent(task.assignedTo, task.calendarEventId, newDeadline);
      }
    }

    await db.collection(Collections.TASKS).doc(taskId).update(updateData);
    return { success: true, message: 'Task updated successfully' };
  }
);

/**
 * Mark a task as completed
 */
export const completeTask = functions.region('asia-south1').https.onCall(
  async (data: CompleteTaskInput, context: functions.https.CallableContext) => {
    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const remark = validateOptionalString(data.remark, 'Remark', 500);

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    if (task.assignedTo !== callerId) {
      throw new functions.https.HttpsError('permission-denied', 'Only assignee can complete');
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new functions.https.HttpsError('failed-precondition', 'Task is not ongoing');
    }

    await db.collection(Collections.TASKS).doc(taskId).update({
      status: TaskStatus.COMPLETED,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completionRemark: remark || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (task.calendarEventId) {
      await deleteCalendarEvent(task.assignedTo, task.calendarEventId);
    }

    // Notification handled by Firestore trigger (notifyTaskStatusChange)

    return { success: true, message: 'Task marked as completed' };
  }
);

/**
 * Cancel a task
 */
export const cancelTask = functions.region('asia-south1').https.onCall(
  async (data: CancelTaskInput, context: functions.https.CallableContext) => {
    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check role from custom claims first, fallback to Firestore if needed
    let isSuperAdmin = context.auth?.token?.role === UserRole.SUPER_ADMIN;

    // Fallback: If custom claims don't show super admin, check Firestore
    if (!isSuperAdmin) {
      const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
      if (callerDoc.exists) {
        isSuperAdmin = callerDoc.data()?.role === UserRole.SUPER_ADMIN;
      }
    }

    const isCreator = task.createdBy === callerId;

    if (!(isSuperAdmin || isCreator)) {
      throw new functions.https.HttpsError('permission-denied', 'Only creator or Super Admin can cancel');
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new functions.https.HttpsError('failed-precondition', 'Can only cancel ongoing tasks');
    }

    await db.collection(Collections.TASKS).doc(taskId).update({
      status: TaskStatus.CANCELLED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (task.calendarEventId) {
      await deleteCalendarEvent(task.assignedTo, task.calendarEventId);
    }

    // Notification handled by Firestore trigger (notifyTaskStatusChange)

    return { success: true, message: 'Task cancelled' };
  }
);

/**
 * Reopen a completed/cancelled task (Super Admin only)
 */
export const reopenTask = functions.region('asia-south1').https.onCall(
  async (data: ReopenTaskInput, context: functions.https.CallableContext) => {
    validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const newDeadline = validateFutureDate(data.newDeadline, 'New deadline');

    const callerRole = context.auth?.token?.role;
    if (callerRole !== UserRole.SUPER_ADMIN) {
      throw new functions.https.HttpsError('permission-denied', 'Only Super Admin can reopen tasks');
    }

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    if (task.status === TaskStatus.ONGOING) {
      throw new functions.https.HttpsError('failed-precondition', 'Task is already ongoing');
    }

    await db.collection(Collections.TASKS).doc(taskId).update({
      status: TaskStatus.ONGOING,
      deadline: admin.firestore.Timestamp.fromDate(newDeadline),
      completedAt: admin.firestore.FieldValue.delete(),
      completionRemark: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await createCalendarEventForUser(task.assignedTo, taskId, task.title, task.subtitle, newDeadline);

    // Send notification for reopened task
    await sendNotification(
      task.assignedTo,
      '🔄 Task Reopened',
      `"${task.title}" • Due ${newDeadline.toLocaleDateString()}`,
      createNotificationData(NotificationType.TASK_ASSIGNED, { taskId })
    );

    return { success: true, message: 'Task reopened' };
  }
);
