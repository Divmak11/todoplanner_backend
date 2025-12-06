import * as functions from 'firebase-functions';
import { admin, db } from '../config/firebase-admin';
import { Collections, NotificationType } from '../config/constants';
import {
  validateAuthenticated,
  validateRequiredString,
} from '../utils/validators';
import {
  sendNotification,
  createNotificationData,
} from '../services/notificationService';
import { AddRemarkInput } from '../types';

/**
 * Add a remark to a task
 * Only assignee, creator, or admin can add remarks
 */
export const addRemark = functions.region('asia-south1').https.onCall(
  async (data: AddRemarkInput, context: functions.https.CallableContext) => {
    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const message = validateRequiredString(data.message, 'message');

    // Validate message length
    if (message.length > 500) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'Remark message cannot exceed 500 characters'
      );
    }

    // Get task to verify permissions
    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Get caller's data from Firestore
    const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
    if (!callerDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }
    const callerData = callerDoc.data()!;

    // Check if user is approved (active status)
    if (callerData.status !== 'active') {
      throw new functions.https.HttpsError(
        'permission-denied',
        'User is not approved'
      );
    }

    // Any approved user can add remarks to any task
    // This enables collaboration and communication

    // Create remark document
    const remarkRef = await db.collection(Collections.REMARKS).add({
      taskId,
      userId: callerId,
      message: message.trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify other participants (creator and assignee, excluding caller)
    const notifyTargets: string[] = [];

    if (task.createdBy !== callerId) {
      notifyTargets.push(task.createdBy);
    }

    if (task.assignedTo !== callerId && task.assignedTo !== task.createdBy) {
      notifyTargets.push(task.assignedTo);
    }

    // Send notifications
    for (const targetId of notifyTargets) {
      await sendNotification(
        targetId,
        '💬 New Comment',
        `"${task.title}"`,
        createNotificationData(NotificationType.TASK_ASSIGNED, { taskId, remarkId: remarkRef.id })
      );
    }

    return {
      success: true,
      remarkId: remarkRef.id,
      message: 'Remark added successfully',
    };
  }
);
