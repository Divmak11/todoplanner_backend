import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
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

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Add a remark to a task
 * Only assignee, creator, or admin can add remarks
 */
export const addRemark = onCall(
  callableConfig,
  async (request: CallableRequest<AddRemarkInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const message = validateRequiredString(data.message, 'message');

    // Validate message length
    if (message.length > 500) {
      throw new HttpsError(
        'invalid-argument',
        'Remark message cannot exceed 500 characters'
      );
    }

    // Get task to verify permissions
    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Get caller's data from Firestore
    const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
    if (!callerDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }
    const callerData = callerDoc.data()!;

    // Check if user is approved (active status)
    if (callerData.status !== 'active') {
      throw new HttpsError(
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

    // Notify other participants (creator and all assignees, excluding caller)
    const notifyTargets = new Set<string>();

    if (task.createdBy !== callerId) {
      notifyTargets.add(task.createdBy);
    }

    // Multi-assignee: notify all assignees except caller
    if (task.isMultiAssignee && task.assigneeIds?.length > 0) {
      for (const assigneeId of task.assigneeIds as string[]) {
        if (assigneeId !== callerId) {
          notifyTargets.add(assigneeId);
        }
      }
    } else if (task.assignedTo && task.assignedTo !== callerId) {
      notifyTargets.add(task.assignedTo);
    }

    // Send notifications in background (non-blocking)
    const notificationPromises = [...notifyTargets].map((targetId) =>
      sendNotification(
        targetId,
        'New Comment',
        `"${task.title}"`,
        createNotificationData(NotificationType.REMARK_ADDED, { taskId, remarkId: remarkRef.id })
      ).catch((err) => console.error(`Failed to notify ${targetId} about remark:`, err))
    );
    Promise.all(notificationPromises).catch(() => { });

    return {
      success: true,
      remarkId: remarkRef.id,
      message: 'Remark added successfully',
    };
  }
);
