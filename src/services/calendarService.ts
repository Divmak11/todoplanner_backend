import * as functions from 'firebase-functions';
import { google, Auth } from 'googleapis';
import { admin, db } from '../config/firebase-admin';
import { Collections, NotificationType } from '../config/constants';
import { sendNotification, createNotificationData } from './notificationService';
import { validateAuthenticated } from '../utils/validators';

/**
 * Result type for getAuthenticatedClient
 */
interface AuthClientResult {
  oauth2Client: Auth.OAuth2Client;
  calendar: ReturnType<typeof google.calendar>;
}

/**
 * Create an authenticated OAuth2 client with automatic token refresh.
 * Listens for token refresh events and persists new tokens to Firestore.
 * 
 * @param userId - The user ID to get tokens for
 * @returns OAuth2 client and Calendar API instance, or null if no valid tokens
 */
async function getAuthenticatedClient(userId: string): Promise<AuthClientResult | null> {
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();

  if (!user) {
    console.log(`User ${userId} not found`);
    return null;
  }

  if (!user.googleCalendarConnected) {
    console.log(`User ${userId} has not connected calendar`);
    return null;
  }

  if (!user.googleAccessToken) {
    console.log(`User ${userId} has no calendar access token`);
    return null;
  }

  const clientId = functions.config().google?.client_id;
  const clientSecret = functions.config().google?.client_secret;

  if (!clientId || !clientSecret) {
    console.error('Google OAuth credentials not configured in Firebase functions config');
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);

  // Set credentials with both access and refresh tokens
  const credentials: {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
  } = {
    access_token: user.googleAccessToken,
    token_type: 'Bearer',
  };

  if (user.googleRefreshToken) {
    credentials.refresh_token = user.googleRefreshToken;
  }

  oauth2Client.setCredentials(credentials);

  // Listen for token refresh events and persist new tokens to Firestore
  oauth2Client.on('tokens', async (tokens) => {
    console.log(`Token refresh event for user ${userId}`);
    const updateData: Record<string, string> = {};

    if (tokens.access_token) {
      updateData.googleAccessToken = tokens.access_token;
      console.log(`New access token obtained for user ${userId}`);
    }

    if (tokens.refresh_token) {
      updateData.googleRefreshToken = tokens.refresh_token;
      console.log(`New refresh token obtained for user ${userId}`);
    }

    if (Object.keys(updateData).length > 0) {
      try {
        await db.collection(Collections.USERS).doc(userId).update(updateData);
        console.log(`Tokens persisted to Firestore for user ${userId}`);
      } catch (error) {
        console.error(`Failed to persist tokens for user ${userId}:`, error);
      }
    }
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  return { oauth2Client, calendar };
}

/**
 * Check if error is an auth error (401/403) that cannot be recovered via refresh.
 * Only resets connection if refresh token is also invalid.
 */
async function handleCalendarAuthError(error: unknown, userId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorWithResponse = error as { response?: { status?: number }; message?: string };
  const status = errorWithResponse?.response?.status;
  const message = errorWithResponse?.message || '';

  // Check if this is an auth error that requires reconnection
  const isAuthError = status === 401 || status === 403;
  const isInvalidGrant = message.includes('invalid_grant') || message.includes('Token has been expired or revoked');

  if (isAuthError || isInvalidGrant) {
    console.log(`Calendar auth failed for user ${userId} (status: ${status}, message: ${message}), resetting connection`);
    await db.collection(Collections.USERS).doc(userId).update({
      googleCalendarConnected: false,
      googleAccessToken: admin.firestore.FieldValue.delete(),
      googleRefreshToken: admin.firestore.FieldValue.delete(),
    });

    // Notify user to reconnect
    await sendNotification(
      userId,
      'Calendar Reconnection Required',
      'Your calendar connection expired. Please reconnect in Settings.',
      createNotificationData(NotificationType.TASK_ASSIGNED, {})
    );
    return true;
  }
  return false;
}

/**
 * Create a Google Calendar event for a task.
 * Uses authenticated client with automatic token refresh.
 */
export async function createCalendarEventForUser(
  userId: string,
  taskId: string,
  title: string,
  subtitle: string,
  deadline: Date
): Promise<string | null> {
  // Check if user has calendar connected
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();

  if (!user?.googleCalendarConnected) {
    // User has not connected calendar - skip silently (no notification spam)
    console.log(`User ${userId} has not connected calendar, skipping event creation`);
    return null;
  }

  // Get authenticated client with token refresh support
  const authResult = await getAuthenticatedClient(userId);
  if (!authResult) {
    console.log(`Could not get authenticated client for user ${userId}`);
    return null;
  }

  const { calendar } = authResult;

  try {
    // Create event with deadline as start time, +1 hour as end time
    const endTime = new Date(deadline.getTime() + 60 * 60 * 1000);

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: subtitle,
        start: { dateTime: deadline.toISOString() },
        end: { dateTime: endTime.toISOString() },
        reminders: {
          useDefault: false,
          overrides: [], // No calendar reminders - app handles all deadline notifications
        },
      },
    });

    const eventId = event.data.id;
    console.log(`Created calendar event ${eventId} for task ${taskId}`);

    // Save event ID to task document
    await db.collection(Collections.TASKS).doc(taskId).update({
      calendarEventId: eventId,
    });

    return eventId ?? null;
  } catch (error) {
    // Check if auth error and reset connection
    await handleCalendarAuthError(error, userId);
    console.error(`Calendar event creation failed for user ${userId}:`, error);
    return null;
  }
}

/**
 * Update a Google Calendar event.
 * Uses authenticated client with automatic token refresh.
 */
export async function updateCalendarEvent(
  userId: string,
  eventId: string,
  newDeadline: Date
): Promise<boolean> {
  // Get authenticated client with token refresh support
  const authResult = await getAuthenticatedClient(userId);
  if (!authResult) {
    console.log(`Could not get authenticated client for user ${userId}`);
    return false;
  }

  const { calendar } = authResult;

  try {
    const endTime = new Date(newDeadline.getTime() + 60 * 60 * 1000);

    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        start: { dateTime: newDeadline.toISOString() },
        end: { dateTime: endTime.toISOString() },
      },
    });

    console.log(`Updated calendar event ${eventId}`);
    return true;
  } catch (error) {
    // Check if auth error and reset connection
    await handleCalendarAuthError(error, userId);
    console.error('Calendar event update failed:', error);
    return false;
  }
}

/**
 * Delete a Google Calendar event.
 * Uses authenticated client with automatic token refresh.
 */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string
): Promise<boolean> {
  // Get authenticated client with token refresh support
  const authResult = await getAuthenticatedClient(userId);
  if (!authResult) {
    console.log(`Could not get authenticated client for user ${userId}`);
    return false;
  }

  const { calendar } = authResult;

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });

    console.log(`Deleted calendar event ${eventId}`);
    return true;
  } catch (error) {
    // Check if auth error and reset connection
    await handleCalendarAuthError(error, userId);
    console.error('Calendar event deletion failed:', error);
    return false;
  }
}

/**
 * Delete all calendar events for a user's tasks
 */
export async function deleteAllUserCalendarEvents(userId: string): Promise<void> {
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();

  if (!user || !user.googleCalendarConnected) {
    return;
  }

  // Get all user's tasks with calendar events
  const tasksSnapshot = await db.collection(Collections.TASKS)
    .where('assignedTo', '==', userId)
    .get();

  for (const taskDoc of tasksSnapshot.docs) {
    const task = taskDoc.data();
    if (task.calendarEventId) {
      await deleteCalendarEvent(userId, task.calendarEventId);
    }
  }
}

/**
 * Disconnect Google Calendar - Callable Cloud Function
 * Deletes all calendar events and clears tokens
 */
export const disconnectCalendar = functions.region('asia-south1').https.onCall(
  async (_data: unknown, context: functions.https.CallableContext) => {
    const userId = validateAuthenticated(context);

    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    const user = userDoc.data();

    if (!user) {
      throw new functions.https.HttpsError('not-found', 'User not found');
    }

    if (!user.googleCalendarConnected) {
      return { success: true, message: 'Calendar not connected' };
    }

    // Delete all calendar events for user's tasks
    await deleteAllUserCalendarEvents(userId);

    // Clear calendar tokens and status
    await db.collection(Collections.USERS).doc(userId).update({
      googleCalendarConnected: false,
      googleAccessToken: admin.firestore.FieldValue.delete(),
      googleRefreshToken: admin.firestore.FieldValue.delete(),
    });

    return { success: true, message: 'Calendar disconnected successfully' };
  }
);
