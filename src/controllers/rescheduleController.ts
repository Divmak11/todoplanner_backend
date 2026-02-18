import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { admin, db } from '../config/firebase-admin';
import {
  Collections,
  TaskStatus,
  ApprovalRequestType,
  ApprovalStatus,
  NotificationType,
  UserRole,
} from '../config/constants';
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
import { updateCalendarEvent } from '../services/calendarService';
import { RequestRescheduleInput, ApproveRescheduleInput } from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Request to reschedule a task deadline
 * Only an assignee can request reschedule
 * For multi-assignee tasks: replaces any existing pending request (only 1 per task)
 */
export const requestReschedule = onCall(
  callableConfig,
  async (request: CallableRequest<RequestRescheduleInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const requesterId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const newDeadline = validateFutureDate(data.newDeadline, 'New deadline');
    const reason = validateOptionalString(data.reason, 'Reason', 500);

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check if requester is an assignee (supports both single and multi-assignee tasks)
    const isAssignee = task.isMultiAssignee
      ? (task.assigneeIds || []).includes(requesterId)
      : task.assignedTo === requesterId;

    if (!isAssignee) {
      throw new HttpsError(
        'permission-denied',
        'Only a task assignee can request a reschedule'
      );
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new HttpsError(
        'failed-precondition',
        'Can only reschedule ongoing tasks'
      );
    }

    // Check for existing pending reschedule request
    const existingRequests = await db.collection(Collections.APPROVAL_REQUESTS)
      .where('targetId', '==', taskId)
      .where('type', '==', ApprovalRequestType.RESCHEDULE)
      .where('status', '==', ApprovalStatus.PENDING)
      .get();

    const batch = db.batch();

    // Delete any existing pending requests (replace behavior for multi-assignee)
    for (const doc of existingRequests.docs) {
      batch.delete(doc.ref);
    }

    // Create new approval request
    const requestRef = db.collection(Collections.APPROVAL_REQUESTS).doc();
    batch.set(requestRef, {
      type: ApprovalRequestType.RESCHEDULE,
      requesterId,
      targetId: taskId,
      payload: {
        newDeadline: admin.firestore.Timestamp.fromDate(newDeadline),
        originalDeadline: task.deadline,
        reason: reason || null,
        taskCreatorId: task.createdBy,
        isMultiAssignee: task.isMultiAssignee || false,
      },
      status: ApprovalStatus.PENDING,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // Notify task creator (who can approve)
    await sendNotification(
      task.createdBy,
      'Reschedule Request',
      `"${task.title}" needs new deadline`,
      createNotificationData(NotificationType.RESCHEDULE_REQUESTED, {
        taskId,
        requestId: requestRef.id,
      })
    );

    return { success: true, requestId: requestRef.id };
  }
);


/**
 * Approve or reject a reschedule request
 * Only the task creator or Super Admin can approve/reject
 * For multi-assignee tasks: updates deadline for all and notifies all assignees
 */
export const approveReschedule = onCall(
  callableConfig,
  async (request: CallableRequest<ApproveRescheduleInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const approverId = validateAuthenticated(context);
    const requestId = validateRequiredString(data.requestId, 'requestId');
    const approved = data.approved;

    if (typeof approved !== 'boolean') {
      throw new HttpsError('invalid-argument', 'approved must be a boolean');
    }

    const requestDoc = await db.collection(Collections.APPROVAL_REQUESTS).doc(requestId).get();
    if (!requestDoc.exists) {
      throw new HttpsError('not-found', 'Request not found');
    }

    const approvalRequest = requestDoc.data()!;

    if (approvalRequest.status !== ApprovalStatus.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        'Request has already been processed'
      );
    }

    const taskId = approvalRequest.targetId;
    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check if approver is task creator or super admin
    const approverDoc = await db.collection(Collections.USERS).doc(approverId).get();
    const approverRole = approverDoc.exists ? approverDoc.data()!.role : null;
    const isSuperAdmin = approverRole === UserRole.SUPER_ADMIN;
    const isTaskCreator = task.createdBy === approverId;

    if (!isTaskCreator && !isSuperAdmin) {
      throw new HttpsError(
        'permission-denied',
        'Only the task creator or Super Admin can approve reschedule requests'
      );
    }

    const batch = db.batch();

    // Update request status
    batch.update(db.collection(Collections.APPROVAL_REQUESTS).doc(requestId), {
      status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
      approverId,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (approved) {
      const newDeadline = approvalRequest.payload.newDeadline;

      // Update task deadline (this affects all assignees since it's the parent task)
      batch.update(db.collection(Collections.TASKS).doc(taskId), {
        deadline: newDeadline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Create reschedule log
      const logRef = db.collection(Collections.RESCHEDULE_LOG).doc();
      batch.set(logRef, {
        taskId,
        requestedBy: approvalRequest.requesterId,
        originalDeadline: approvalRequest.payload.originalDeadline,
        newDeadline,
        approvedBy: approverId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    // Update calendar events and send notifications
    const newDeadlineDate = approved ? approvalRequest.payload.newDeadline.toDate() : null;
    const notificationTitle = approved ? 'Reschedule Approved' : 'Reschedule Declined';
    const notificationBody = approved
      ? `"${task.title}" • New deadline ${newDeadlineDate?.toLocaleDateString()}`
      : `"${task.title}" request declined`;

    // Handle based on task type
    if (task.isMultiAssignee && task.assigneeIds?.length > 0) {
      // MULTI-ASSIGNEE: Update all calendar events and notify all assignees
      const assigneeIds: string[] = task.assigneeIds;

      // Update calendar events for all assignees
      if (approved) {
        const assignmentsSnapshot = await db
          .collection(Collections.TASKS)
          .doc(taskId)
          .collection(Collections.ASSIGNMENTS)
          .get();

        const calendarPromises = assignmentsSnapshot.docs.map(async (assignmentDoc) => {
          const assignment = assignmentDoc.data();
          if (assignment.calendarEventId && newDeadlineDate) {
            await updateCalendarEvent(
              assignment.userId,
              assignment.calendarEventId,
              newDeadlineDate
            ).catch((err) =>
              console.error(`Failed to update calendar for ${assignment.userId}:`, err)
            );
          }
        });

        Promise.all(calendarPromises).catch((err) =>
          console.error('Calendar update batch failed:', err)
        );
      }

      // Notify all assignees
      const notificationPromises = assigneeIds.map((userId) =>
        sendNotification(
          userId,
          notificationTitle,
          notificationBody,
          createNotificationData(
            approved ? NotificationType.RESCHEDULE_APPROVED : NotificationType.RESCHEDULE_REJECTED,
            { taskId, requestId }
          )
        ).catch((err) => console.error(`Failed to notify ${userId}:`, err))
      );

      Promise.all(notificationPromises).catch((err) =>
        console.error('Notification batch failed:', err)
      );
    } else {
      // SINGLE-ASSIGNEE: Update single calendar event and notify requester
      if (approved && task.calendarEventId && task.assignedTo) {
        updateCalendarEvent(task.assignedTo, task.calendarEventId, newDeadlineDate!).catch(
          (err) => console.error('Failed to update calendar:', err)
        );
      }

      await sendNotification(
        approvalRequest.requesterId,
        notificationTitle,
        notificationBody,
        createNotificationData(
          approved ? NotificationType.RESCHEDULE_APPROVED : NotificationType.RESCHEDULE_REJECTED,
          { taskId, requestId }
        )
      );
    }

    return { success: true, message: approved ? 'Reschedule approved' : 'Reschedule rejected' };
  }
);
