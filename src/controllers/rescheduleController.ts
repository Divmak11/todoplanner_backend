import * as functions from 'firebase-functions';
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

/**
 * Request to reschedule a task deadline
 * Only the assignee can request reschedule
 */
export const requestReschedule = functions.region('asia-south1').https.onCall(
  async (data: RequestRescheduleInput, context: functions.https.CallableContext) => {
    const requesterId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const newDeadline = validateFutureDate(data.newDeadline, 'New deadline');
    const reason = validateOptionalString(data.reason, 'Reason', 500);

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Only assignee can request reschedule
    if (task.assignedTo !== requesterId) {
      throw new functions.https.HttpsError(
        'permission-denied',
        'Only the task assignee can request a reschedule'
      );
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Can only reschedule ongoing tasks'
      );
    }

    // Check if there's already a pending reschedule request
    const existingRequest = await db.collection(Collections.APPROVAL_REQUESTS)
      .where('targetId', '==', taskId)
      .where('type', '==', ApprovalRequestType.RESCHEDULE)
      .where('status', '==', ApprovalStatus.PENDING)
      .get();

    if (!existingRequest.empty) {
      throw new functions.https.HttpsError(
        'already-exists',
        'A reschedule request is already pending for this task'
      );
    }

    // Create approval request
    const requestRef = await db.collection(Collections.APPROVAL_REQUESTS).add({
      type: ApprovalRequestType.RESCHEDULE,
      requesterId,
      targetId: taskId,
      payload: {
        newDeadline: admin.firestore.Timestamp.fromDate(newDeadline),
        originalDeadline: task.deadline,
        reason: reason || null,
        taskCreatorId: task.createdBy, // Required for Flutter query
      },
      status: ApprovalStatus.PENDING,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify task creator (who can approve)
    await sendNotification(
      task.createdBy,
      '📅 Reschedule Request',
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
 * Only the task creator can approve/reject
 */
export const approveReschedule = functions.region('asia-south1').https.onCall(
  async (data: ApproveRescheduleInput, context: functions.https.CallableContext) => {
    const approverId = validateAuthenticated(context);
    const requestId = validateRequiredString(data.requestId, 'requestId');
    const approved = data.approved;

    if (typeof approved !== 'boolean') {
      throw new functions.https.HttpsError('invalid-argument', 'approved must be a boolean');
    }

    const requestDoc = await db.collection(Collections.APPROVAL_REQUESTS).doc(requestId).get();
    if (!requestDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Request not found');
    }

    const request = requestDoc.data()!;

    if (request.status !== ApprovalStatus.PENDING) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'Request has already been processed'
      );
    }

    const taskId = request.targetId;
    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check if approver is task creator or super admin
    const approverDoc = await db.collection(Collections.USERS).doc(approverId).get();
    const approverRole = approverDoc.exists ? approverDoc.data()!.role : null;
    const isSuperAdmin = approverRole === UserRole.SUPER_ADMIN;
    const isTaskCreator = task.createdBy === approverId;

    if (!isTaskCreator && !isSuperAdmin) {
      throw new functions.https.HttpsError(
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
      const newDeadline = request.payload.newDeadline;

      // Update task deadline
      batch.update(db.collection(Collections.TASKS).doc(taskId), {
        deadline: newDeadline,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Create reschedule log
      const logRef = db.collection(Collections.RESCHEDULE_LOG).doc();
      batch.set(logRef, {
        taskId,
        requestedBy: request.requesterId,
        originalDeadline: request.payload.originalDeadline,
        newDeadline,
        approvedBy: approverId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await batch.commit();

    // Update calendar event if approved
    if (approved && task.calendarEventId) {
      const newDeadlineDate = request.payload.newDeadline.toDate();
      await updateCalendarEvent(task.assignedTo, task.calendarEventId, newDeadlineDate);
    }

    // Notify requester
    const newDeadlineDate = approved ? request.payload.newDeadline.toDate() : null;
    const notificationTitle = approved ? '✅ Reschedule Approved' : '❌ Reschedule Declined';
    const notificationBody = approved ?
      `"${task.title}" • New deadline ${newDeadlineDate?.toLocaleDateString()}` :
      `"${task.title}" request declined`;

    await sendNotification(
      request.requesterId,
      notificationTitle,
      notificationBody,
      createNotificationData(
        approved ? NotificationType.RESCHEDULE_APPROVED : NotificationType.RESCHEDULE_REJECTED,
        { taskId, requestId }
      )
    );

    return { success: true, message: approved ? 'Reschedule approved' : 'Reschedule rejected' };
  }
);
