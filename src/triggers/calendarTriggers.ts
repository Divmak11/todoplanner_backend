import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { admin, db } from '../config/firebase-admin';
import { Collections, TaskStatus, TaskAssignmentStatus } from '../config/constants';
import { createCalendarEventForUser, updateCalendarEvent, deleteCalendarEvent } from '../services/calendarService';

// 2nd Gen configuration for Firestore triggers
const triggerConfig = { region: 'asia-south1' };

/**
 * Handle Task changes (Create, Update, Delete) for Calendar Synchronization
 */
export const onTaskWrite = onDocumentWritten(
    { document: `${Collections.TASKS}/{taskId}`, ...triggerConfig },
    async (event) => {
        const change = event.data;
        if (!change) return;

        const taskId = event.params.taskId;
        const before = change.before.exists ? change.before.data() : null;
        const after = change.after.exists ? change.after.data() : null;

        // 1. HANDLE TASK DELETION
        if (!after) {
            // If task was multi-assignee, assignments are deleted separately (or handled by their own trigger if deleted)
            // But if we delete the task doc, we should ensure cleanup if possible.
            // However, usually we can't easily query subcollections of a deleted doc.
            // We rely on 'status: CANCELLED' or 'assignment deleted' triggers.
            // If single-assignee legacy task:
            if (before && !before.isMultiAssignee && before.calendarEventId && before.assignedTo) {
                console.log(`[CalendarTrigger] Task deleted, removing event for ${before.assignedTo}`);
                await deleteCalendarEvent(before.assignedTo, before.calendarEventId);
            }
            return;
        }

        // 2. HANDLE TASK CREATION (Single Assignee)
        if (!before && after) {
            // Multi-assignee tasks are handled by onAssignmentWrite
            if (after.isMultiAssignee) return;

            if (after.assignedTo && after.deadline && after.status === TaskStatus.ONGOING) {
                // Prevent loop: createCalendarEventForUser writes to the doc
                if (after.calendarEventId) return;

                console.log(`[CalendarTrigger] Task created, creating event for ${after.assignedTo}`);
                // This will update the task doc with calendarEventId
                await createCalendarEventForUser(
                    after.assignedTo,
                    taskId,
                    after.title,
                    after.subtitle || '',
                    after.deadline.toDate(),
                    false // Allow updating task doc
                );
            }
            return;
        }

        // 3. HANDLE TASK UPDATE
        if (before && after) {
            // A. Status Changes (Completion / Cancellation / Reopening)
            if (before.status !== after.status) {
                const isNowInactive = after.status === TaskStatus.COMPLETED || after.status === TaskStatus.CANCELLED;
                const wasInactive = before.status === TaskStatus.COMPLETED || before.status === TaskStatus.CANCELLED;
                const isNowActive = after.status === TaskStatus.ONGOING;

                // Clean up events if becoming inactive
                if (isNowInactive) {
                    if (after.isMultiAssignee) {
                        // Multi-assignee: delete all assignment events
                        // Note: assignments should ideally catch their own status changes, but if parent status changes,
                        // assignments might stay 'ONGOING' in DB but logically be cancelled?
                        // Usually updateTask(CANCEL) updates triggers.
                        // But let's be safe. If parent is cancelled, assignments are effectively cancelled.
                        // Efficient way: Query assignments with calendarEventId
                        const assignmentsSnap = await db.collection(Collections.TASKS).doc(taskId)
                            .collection(Collections.ASSIGNMENTS)
                            .where('calendarEventId', '!=', null) // Only those with events
                            .get();

                        const promises = assignmentsSnap.docs.map(async (doc) => {
                            const data = doc.data();
                            if (data.userId && data.calendarEventId) {
                                await deleteCalendarEvent(data.userId, data.calendarEventId);
                                await doc.ref.update({ calendarEventId: admin.firestore.FieldValue.delete() });
                            }
                        });
                        await Promise.all(promises);
                    } else {
                        // Single assignee
                        if (after.calendarEventId && after.assignedTo) {
                            await deleteCalendarEvent(after.assignedTo, after.calendarEventId);
                            await change.after.ref.update({ calendarEventId: admin.firestore.FieldValue.delete() });
                        }
                    }
                }

                // Create/Restore events if becoming active (Reopen)
                else if (isNowActive && wasInactive) {
                    // Reopen logic is handled by the controller usually resetting everything.
                    // If controller resets state, this trigger might see standard 'ONGOING' state.
                    // But if controller already initiated 'createCalendarEvent', we might duplicate?
                    // The Controller in the new plan *removes* direct calls. So we MUST handle it here.

                    if (after.isMultiAssignee) {
                        // We can't easily recreate assignment events here because we need to know WHICH assignments are active.
                        // But 'reopenTask' usually resets assignments to ONGOING.
                        // So onAssignmentWrite should handle creation!
                        // So we do NOTHING here for multi-assignee reopen.
                    } else {
                        // Single assignee restore
                        if (!after.calendarEventId && after.assignedTo) {
                            await createCalendarEventForUser(
                                after.assignedTo,
                                taskId,
                                after.title,
                                after.subtitle || '',
                                after.deadline.toDate(),
                                false
                            );
                        }
                    }
                }
            }

            // B. Details Update (Title / Deadline / Subtitle) - Only if Ongoing
            else if (after.status === TaskStatus.ONGOING) {
                const deadlineChanged = !before.deadline.isEqual(after.deadline);
                const titleChanged = before.title !== after.title;
                const subtitleChanged = (before.subtitle || '') !== (after.subtitle || '');

                if (deadlineChanged || titleChanged || subtitleChanged) {
                    const newDeadline = deadlineChanged ? after.deadline.toDate() : undefined;
                    const newTitle = titleChanged ? after.title : undefined;
                    const newSubtitle = subtitleChanged ? (after.subtitle || '') : undefined;

                    if (after.isMultiAssignee) {
                        // Update all assignees
                        const assignmentsSnap = await db.collection(Collections.TASKS).doc(taskId)
                            .collection(Collections.ASSIGNMENTS)
                            .get();

                        const promises = assignmentsSnap.docs.map(doc => {
                            const data = doc.data();
                            if (data.userId && data.calendarEventId) {
                                return updateCalendarEvent(
                                    data.userId,
                                    data.calendarEventId,
                                    newDeadline,
                                    newTitle,
                                    newSubtitle
                                );
                            }
                            return Promise.resolve(false);
                        });
                        await Promise.all(promises);
                    } else {
                        // Single assignee
                        if (after.calendarEventId && after.assignedTo) {
                            await updateCalendarEvent(
                                after.assignedTo,
                                after.calendarEventId,
                                newDeadline,
                                newTitle,
                                newSubtitle
                            );
                        }
                    }
                }
            }
        }
    }
);


/**
 * Handle Assignment changes for Multi-Assignee Tasks
 */
export const onAssignmentWrite = onDocumentWritten(
    { document: `${Collections.TASKS}/{taskId}/${Collections.ASSIGNMENTS}/{assignmentId}`, ...triggerConfig },
    async (event) => {
        const change = event.data;
        if (!change) return;

        const taskId = event.params.taskId;
        const before = change.before.exists ? change.before.data() : null;
        const after = change.after.exists ? change.after.data() : null;

        // 1. ASSIGNMENT DELETED
        if (!after) {
            if (before && before.calendarEventId && before.userId) {
                console.log(`[CalendarTrigger] Assignment deleted, removing event for ${before.userId}`);
                await deleteCalendarEvent(before.userId, before.calendarEventId);
            }
            return;
        }

        // Fetch Parent Task (needed for details)
        const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
        const task = taskDoc.data();

        if (!task) return; // Parent task missing?

        // 2. ASSIGNMENT CREATED
        if (!before && after) {
            if (after.status === TaskAssignmentStatus.ONGOING && task.status === TaskStatus.ONGOING) {
                if (after.calendarEventId) return; // Already has event

                if (after.userId && task.deadline) {
                    console.log(`[CalendarTrigger] Assignment created, creating event for ${after.userId}`);
                    // Pass true to skip Task Doc update (we update Assignment Doc manually)
                    const eventId = await createCalendarEventForUser(
                        after.userId,
                        taskId,
                        task.title,
                        task.subtitle || '',
                        task.deadline.toDate(),
                        true
                    );

                    if (eventId) {
                        await change.after.ref.update({ calendarEventId: eventId });
                    }
                }
            }
            return;
        }

        // 3. ASSIGNMENT UPDATED
        if (before && after) {
            // Check status change
            if (before.status !== after.status) {
                if (after.status === TaskAssignmentStatus.COMPLETED) {
                    // Completed -> Delete Event
                    if (after.calendarEventId && after.userId) {
                        await deleteCalendarEvent(after.userId, after.calendarEventId);
                        await change.after.ref.update({ calendarEventId: admin.firestore.FieldValue.delete() });
                    }
                } else if (after.status === TaskAssignmentStatus.ONGOING && before.status === TaskAssignmentStatus.COMPLETED) {
                    // Reopened (if that happens at assignment level)
                    if (!after.calendarEventId && after.userId && task.deadline) {
                        const eventId = await createCalendarEventForUser(
                            after.userId,
                            taskId,
                            task.title,
                            task.subtitle || '',
                            task.deadline.toDate(),
                            true
                        );
                        if (eventId) {
                            await change.after.ref.update({ calendarEventId: eventId });
                        }
                    }
                }
            }
        }
    }
);
