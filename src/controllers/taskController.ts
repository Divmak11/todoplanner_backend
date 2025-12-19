import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { admin, db } from '../config/firebase-admin';
import {
  Collections,
  TaskStatus,
  TaskAssignmentStatus,
  AssignmentType,
  UserRole,
  NotificationType,
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
import {
  AssignTaskInput,
  UpdateTaskInput,
  CompleteTaskInput,
  CompleteAssignmentInput,
  CancelTaskInput,
  ReopenTaskInput,
} from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

/**
 * Assign a new task to a member, multiple members, or team
 *
 * Architecture:
 * - Single assignee (1 person): Legacy structure with assignedTo field (backward compatible)
 * - Multiple assignees (2+ people): Parent task with assignments subcollection
 * - Team assignment: Resolves to multi-assignee with all team members
 */
export const assignTask = onCall(
  callableConfig,
  async (request: CallableRequest<AssignTaskInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const createdBy = validateAuthenticated(context);
    const title = validateRequiredString(data.title, 'Title');
    const subtitle = data.subtitle || '';
    const assignedType = data.assignedType;
    const deadline = validateFutureDate(data.deadline, 'Deadline');
    const supervisorIds = data.supervisorIds || [];

    if (assignedType !== AssignmentType.MEMBER && assignedType !== AssignmentType.TEAM) {
      throw new HttpsError(
        'invalid-argument',
        'assignedType must be "member" or "team"'
      );
    }

    const deadlineTimestamp = admin.firestore.Timestamp.fromDate(deadline);

    // Resolve assignee IDs (handle team assignment by expanding to members)
    let assigneeIds: string[] = [];
    let sourceTeamId: string | null = null;

    if (assignedType === AssignmentType.TEAM) {
      const teamId = Array.isArray(data.assignedTo) ? data.assignedTo[0] : data.assignedTo;
      validateRequiredString(teamId, 'assignedTo');

      const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
      if (!teamDoc.exists) {
        throw new HttpsError('not-found', 'Team not found');
      }

      const team = teamDoc.data()!;
      assigneeIds = team.memberIds || [];
      sourceTeamId = teamId;

      if (assigneeIds.length === 0) {
        throw new HttpsError('failed-precondition', 'Team has no members');
      }
    } else {
      // Member assignment
      assigneeIds = Array.isArray(data.assignedTo) ? data.assignedTo : [data.assignedTo];
    }

    if (assigneeIds.length === 0) {
      throw new HttpsError('invalid-argument', 'At least one assignee required');
    }

    // Validate all assignees exist
    const userChecks = await Promise.all(
      assigneeIds.map((id) => db.collection(Collections.USERS).doc(id).get())
    );

    const invalidUsers = userChecks.filter((doc) => !doc.exists);
    if (invalidUsers.length > 0) {
      throw new HttpsError('not-found', 'One or more users not found');
    }

    // Validate supervisors exist and are part of assignees
    if (supervisorIds.length > 0) {
      const invalidSupervisors = supervisorIds.filter((id) => !assigneeIds.includes(id));
      if (invalidSupervisors.length > 0) {
        throw new HttpsError(
          'invalid-argument',
          'Supervisors must be assignees'
        );
      }
    }

    // SINGLE ASSIGNEE: Use legacy structure for backward compatibility
    if (assigneeIds.length === 1) {
      const assignedTo = assigneeIds[0];
      const taskRef = await db.collection(Collections.TASKS).add({
        title,
        subtitle,
        assignedType: AssignmentType.MEMBER,
        assignedTo,
        createdBy,
        status: TaskStatus.ONGOING,
        deadline: deadlineTimestamp,
        isMultiAssignee: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { success: true, taskId: taskRef.id };
    }

    // MULTI-ASSIGNEE: Create parent task with assignments subcollection
    const batch = db.batch();
    const taskRef = db.collection(Collections.TASKS).doc();

    // Create parent task
    const parentTaskData: Record<string, unknown> = {
      title,
      subtitle,
      assignedType: assignedType,
      createdBy,
      status: TaskStatus.ONGOING,
      deadline: deadlineTimestamp,
      isMultiAssignee: true,
      assigneeIds,
      supervisorIds,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (sourceTeamId) {
      parentTaskData.sourceTeamId = sourceTeamId;
    }

    batch.set(taskRef, parentTaskData);

    // Create assignment subdocs for each assignee
    const assignmentRefs: { userId: string; ref: FirebaseFirestore.DocumentReference }[] = [];
    for (const userId of assigneeIds) {
      const assignmentRef = taskRef.collection(Collections.ASSIGNMENTS).doc();
      batch.set(assignmentRef, {
        userId,
        status: TaskAssignmentStatus.ONGOING,
        assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      assignmentRefs.push({ userId, ref: assignmentRef });
    }

    await batch.commit();

    return { success: true, taskId: taskRef.id, isMultiAssignee: true };
  }
);

/**
 * Update a task (title, subtitle, deadline)
 */
export const updateTask = onCall(
  callableConfig,
  async (request: CallableRequest<UpdateTaskInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const updates = data.updates;

    if (!updates || Object.keys(updates).length === 0) {
      throw new HttpsError('invalid-argument', 'No updates provided');
    }

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check isCreator first - if true, skip expensive role checks entirely
    const isCreator = task.createdBy === callerId;

    // Check role from custom claims first
    let isSuperAdmin = context.auth?.token?.role === UserRole.SUPER_ADMIN;

    // Only fallback to Firestore if not creator and custom claims don't show super admin
    // This avoids unnecessary Firestore read when caller is the task creator
    if (!isCreator && !isSuperAdmin) {
      const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
      if (callerDoc.exists) {
        isSuperAdmin = callerDoc.data()?.role === UserRole.SUPER_ADMIN;
      }
    }

    if (!(isSuperAdmin || isCreator)) {
      throw new HttpsError('permission-denied', 'Only task creator or Super Admin can update');
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new HttpsError('failed-precondition', 'Can only update ongoing tasks');
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

    await db.collection(Collections.TASKS).doc(taskId).update(updateData);

    // Send update notifications to assignees (calendar can't notify about updates)
    const updatedFields: string[] = [];
    if (updates.title !== undefined) updatedFields.push('title');
    if (updates.subtitle !== undefined) updatedFields.push('description');
    if (updates.deadline !== undefined) {
      const newDeadline = new Date(updates.deadline);
      updatedFields.push(`deadline: ${newDeadline.toLocaleDateString()}`);
    }

    // Fire-and-forget: Send notifications in background (non-blocking)
    if (updatedFields.length > 0) {
      const updateMessage = `"${task.title}" updated • ${updatedFields.join(', ')}`;

      if (task.isMultiAssignee && task.assigneeIds?.length > 0) {
        // Multi-assignee: notify all assignees except the caller (in parallel)
        const assigneesToNotify = (task.assigneeIds as string[]).filter(
          (id: string) => id !== callerId
        );
        const notificationPromises = assigneesToNotify.map((assigneeId) =>
          sendNotification(
            assigneeId,
            '📝 Task Updated',
            updateMessage,
            createNotificationData(NotificationType.TASK_UPDATED, { taskId })
          ).catch((err) => console.error(`Failed to notify ${assigneeId}:`, err))
        );
        // Don't await - let notifications complete in background
        Promise.all(notificationPromises).catch((error) => {
          console.error('Background notifications failed:', error);
        });
      } else if (task.assignedTo && task.assignedTo !== callerId) {
        // Single-assignee: notify assignee if not the caller (fire-and-forget)
        sendNotification(
          task.assignedTo,
          '📝 Task Updated',
          updateMessage,
          createNotificationData(NotificationType.TASK_UPDATED, { taskId })
        ).catch((err) => console.error('Failed to notify assignee:', err));
      }
    }

    return { success: true, message: 'Task updated successfully' };
  }
);

/**
 * Internal function to complete an assignment for multi-assignee tasks
 * @param {string} taskId - The task document ID
 * @param {string} callerId - The user completing their assignment
 * @param {string | null | undefined} remark - Optional completion remark
 * @param {FirebaseFirestore.DocumentData} task - The task document data
 */
async function completeAssignmentInternal(
  taskId: string,
  callerId: string,
  remark: string | null | undefined,
  task: FirebaseFirestore.DocumentData
): Promise<{ success: boolean; message: string; allCompleted?: boolean }> {
  // Find the caller's assignment
  const assignmentsRef = db.collection(Collections.TASKS).doc(taskId)
    .collection(Collections.ASSIGNMENTS);

  const assignmentQuery = await assignmentsRef.where('userId', '==', callerId).get();

  if (assignmentQuery.empty) {
    throw new HttpsError('permission-denied', 'You are not assigned to this task');
  }

  const assignmentDoc = assignmentQuery.docs[0];
  const assignment = assignmentDoc.data();

  if (assignment.status === TaskAssignmentStatus.COMPLETED) {
    throw new HttpsError('failed-precondition', 'You have already completed this task');
  }

  // Build assignment update data
  const assignmentUpdateData: Record<string, unknown> = {
    status: TaskAssignmentStatus.COMPLETED,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    completionRemark: remark || null,
  };

  // Update the assignment
  await assignmentDoc.ref.update(assignmentUpdateData);

  // Check if all assignments are now complete
  const allAssignments = await assignmentsRef.get();
  const allCompleted = allAssignments.docs.every(
    (doc) => doc.data().status === TaskAssignmentStatus.COMPLETED
  );

  // Update parent task status if all complete
  if (allCompleted) {
    await db.collection(Collections.TASKS).doc(taskId).update({
      status: TaskStatus.COMPLETED,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    // Just update the updatedAt timestamp
    await db.collection(Collections.TASKS).doc(taskId).update({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Send notification to creator about this user's completion
  await sendNotification(
    task.createdBy,
    '✅ Task Progress',
    `An assignee completed "${task.title}"${allCompleted ? ' (All done!)' : ''}`,
    createNotificationData(NotificationType.TASK_COMPLETED, { taskId })
  ).catch((error) => {
    console.error('Failed to send completion notification:', error);
  });

  return {
    success: true,
    message: allCompleted ? 'Task fully completed' : 'Your assignment marked as completed',
    allCompleted,
  };
}

/**
 * Mark a task as completed (for single-assignee tasks or legacy tasks)
 * For multi-assignee tasks, use completeAssignment instead
 */
export const completeTask = onCall(
  callableConfig,
  async (request: CallableRequest<CompleteTaskInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const remark = validateOptionalString(data.remark, 'Remark', 500);

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // For multi-assignee tasks, redirect to completeAssignment logic
    if (task.isMultiAssignee) {
      return completeAssignmentInternal(taskId, callerId, remark, task);
    }

    // Legacy single-assignee task handling
    if (task.assignedTo !== callerId) {
      throw new HttpsError('permission-denied', 'Only assignee can complete');
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new HttpsError('failed-precondition', 'Task is not ongoing');
    }

    const taskUpdateData: Record<string, unknown> = {
      status: TaskStatus.COMPLETED,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      completionRemark: remark || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection(Collections.TASKS).doc(taskId).update(taskUpdateData);

    // Notification handled by Firestore trigger (notifyTaskStatusChange)

    return { success: true, message: 'Task marked as completed' };
  }
);

/**
 * Complete an assignment for multi-assignee tasks
 * Each assignee can complete their own assignment independently
 */
export const completeAssignment = onCall(
  callableConfig,
  async (request: CallableRequest<CompleteAssignmentInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const remark = validateOptionalString(data.remark, 'Remark', 500);

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    if (!task.isMultiAssignee) {
      throw new HttpsError(
        'failed-precondition',
        'Use completeTask for single-assignee tasks'
      );
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new HttpsError('failed-precondition', 'Task is not ongoing');
    }

    return completeAssignmentInternal(taskId, callerId, remark, task);
  }
);

/**
 * Cancel a task (works for both single and multi-assignee tasks)
 */
export const cancelTask = onCall(
  callableConfig,
  async (request: CallableRequest<CancelTaskInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    // Check isCreator first - if true, skip expensive role checks entirely
    const isCreator = task.createdBy === callerId;

    // Check role from custom claims first
    let isSuperAdmin = context.auth?.token?.role === UserRole.SUPER_ADMIN;

    // Only fallback to Firestore if not creator and custom claims don't show super admin
    // This avoids unnecessary Firestore read when caller is the task creator
    if (!isCreator && !isSuperAdmin) {
      const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
      if (callerDoc.exists) {
        isSuperAdmin = callerDoc.data()?.role === UserRole.SUPER_ADMIN;
      }
    }

    if (!(isSuperAdmin || isCreator)) {
      throw new HttpsError(
        'permission-denied',
        'Only creator or Super Admin can cancel'
      );
    }

    if (task.status !== TaskStatus.ONGOING) {
      throw new HttpsError('failed-precondition', 'Can only cancel ongoing tasks');
    }

    // Build task update data
    const taskUpdateData: Record<string, unknown> = {
      status: TaskStatus.CANCELLED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Handle calendar event deletion (handled by Firestore Trigger)

    await db.collection(Collections.TASKS).doc(taskId).update(taskUpdateData);

    // Notification handled by Firestore trigger (notifyTaskStatusChange)

    return { success: true, message: 'Task cancelled' };
  }
);

/**
 * Reopen a completed/cancelled task (Super Admin only)
 * Works for both single and multi-assignee tasks
 */
export const reopenTask = onCall(
  callableConfig,
  async (request: CallableRequest<ReopenTaskInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const callerId = validateAuthenticated(context);
    const taskId = validateRequiredString(data.taskId, 'taskId');
    const newDeadline = validateFutureDate(data.newDeadline, 'New deadline');

    // Check role from custom claims first, fallback to Firestore if needed
    let isSuperAdmin = context.auth?.token?.role === UserRole.SUPER_ADMIN;

    // Fallback: If custom claims don't show super admin, check Firestore
    if (!isSuperAdmin) {
      const callerDoc = await db.collection(Collections.USERS).doc(callerId).get();
      if (callerDoc.exists) {
        isSuperAdmin = callerDoc.data()?.role === UserRole.SUPER_ADMIN;
      }
    }

    if (!isSuperAdmin) {
      throw new HttpsError(
        'permission-denied',
        'Only Super Admin can reopen tasks'
      );
    }

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    if (!taskDoc.exists) {
      throw new HttpsError('not-found', 'Task not found');
    }

    const task = taskDoc.data()!;

    if (task.status === TaskStatus.ONGOING) {
      throw new HttpsError('failed-precondition', 'Task is already ongoing');
    }

    const deadlineTimestamp = admin.firestore.Timestamp.fromDate(newDeadline);

    // Update parent task
    await db.collection(Collections.TASKS).doc(taskId).update({
      status: TaskStatus.ONGOING,
      deadline: deadlineTimestamp,
      completedAt: admin.firestore.FieldValue.delete(),
      completionRemark: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (task.isMultiAssignee) {
      // Multi-assignee: reset all assignments and create calendar events
      const assignmentsRef = db.collection(Collections.TASKS).doc(taskId)
        .collection(Collections.ASSIGNMENTS);
      const assignments = await assignmentsRef.get();

      const batch = db.batch();
      const assigneeIds: string[] = [];

      assignments.docs.forEach((doc) => {
        const assignment = doc.data();
        assigneeIds.push(assignment.userId);
        batch.update(doc.ref, {
          status: TaskAssignmentStatus.ONGOING,
          completedAt: admin.firestore.FieldValue.delete(),
          completionRemark: admin.firestore.FieldValue.delete(),
        });
      });

      await batch.commit();

      // Fire-and-forget: Send notifications in background (non-blocking)
      const notificationPromises = assigneeIds.map((userId) =>
        sendNotification(
          userId,
          '🔄 Task Reopened',
          `"${task.title}" • Due ${newDeadline.toLocaleDateString()}`,
          createNotificationData(NotificationType.TASK_ASSIGNED, { taskId })
        ).catch((error) => {
          console.error(`Failed to send notification to ${userId}:`, error);
        })
      );

      // Don't await - let operations complete in background
      Promise.all(notificationPromises).catch((error) => {
        console.error('Background reopen operations failed:', error);
      });
    } else if (task.assignedTo) {
      const notificationPromise = sendNotification(
        task.assignedTo,
        '🔄 Task Reopened',
        `"${task.title}" • Due ${newDeadline.toLocaleDateString()}`,
        createNotificationData(NotificationType.TASK_ASSIGNED, { taskId })
      ).catch((error) => {
        console.error('Failed to send notification:', error);
      });

      // Don't await - let operations complete in background
      Promise.all([notificationPromise]).catch((error) => {
        console.error('Background reopen operations failed:', error);
      });
    }

    return { success: true, message: 'Task reopened' };
  }
);
