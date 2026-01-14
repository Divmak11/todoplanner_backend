// Note: Using process.env for v2 functions (functions.config() is deprecated)
import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import { google, Auth } from 'googleapis';
import { db, admin } from '../config/firebase-admin';
import { Collections, NotificationType, TaskStatus, TaskAssignmentStatus } from '../config/constants';
import { sendNotification, createNotificationData } from './notificationService';
import { validateAuthenticated } from '../utils/validators';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

// ============================================================================
// CALENDAR LOGGING - Enhanced for debugging token refresh and sync
// ============================================================================
const LOG_PREFIX = '📅 [CALENDAR]';

// eslint-disable-next-line jsdoc/require-jsdoc
function calendarLog(
  operation: string, userId: string, details: Record<string, unknown> = {}
): void {
  const ts = new Date().toISOString();
  console.log(`${LOG_PREFIX} [${ts}] [${operation}] user=${userId}`, details);
}

// eslint-disable-next-line jsdoc/require-jsdoc
function calendarError(
  operation: string, userId: string, error: unknown, details: Record<string, unknown> = {}
): void {
  const ts = new Date().toISOString();
  console.error(`${LOG_PREFIX} [${ts}] [${operation}] ERROR user=${userId}`, { ...details, error });
}

interface AuthClientResult {
  oauth2Client: Auth.OAuth2Client;
  calendar: ReturnType<typeof google.calendar>;
}

/**
 * Type for the Calendar API instance to avoid repetitive ReturnType usage
 */
type CalendarApi = ReturnType<typeof google.calendar>;

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
    calendarLog('GET_AUTH_CLIENT', userId, { status: 'FAILED', reason: 'user_not_found' });
    return null;
  }

  if (!user.googleCalendarConnected) {
    calendarLog('GET_AUTH_CLIENT', userId, { status: 'SKIPPED', reason: 'calendar_not_connected' });
    return null;
  }

  if (!user.googleAccessToken) {
    calendarLog('GET_AUTH_CLIENT', userId, { status: 'FAILED', reason: 'no_access_token' });
    return null;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    calendarError('GET_AUTH_CLIENT', userId, 'Missing OAuth config', {
      hasClientId: !!clientId, hasClientSecret: !!clientSecret,
    });
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

  calendarLog('GET_AUTH_CLIENT', userId, {
    status: 'SUCCESS',
    hasAccessToken: !!user.googleAccessToken,
    hasRefreshToken: !!user.googleRefreshToken,
    accessTokenPreview: user.googleAccessToken?.substring(0, 20) + '...',
  });

  oauth2Client.setCredentials(credentials);

  // Listen for token refresh events and persist new tokens to Firestore
  oauth2Client.on('tokens', async (tokens) => {
    calendarLog('TOKEN_REFRESH_EVENT', userId, {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      newAccessTokenPreview: tokens.access_token?.substring(0, 20) + '...',
    });

    const updateData: Record<string, string> = {};

    if (tokens.access_token) {
      updateData.googleAccessToken = tokens.access_token;
    }

    if (tokens.refresh_token) {
      updateData.googleRefreshToken = tokens.refresh_token;
    }

    if (Object.keys(updateData).length > 0) {
      try {
        await db.collection(Collections.USERS).doc(userId).update(updateData);
        calendarLog('TOKEN_SAVED_TO_FIRESTORE', userId, {
          savedAccessToken: !!updateData.googleAccessToken,
          savedRefreshToken: !!updateData.googleRefreshToken,
        });
      } catch (error) {
        calendarError('TOKEN_SAVE_FAILED', userId, error, {});
      }
    }
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  return { oauth2Client, calendar };
}

/**
 * Check if error is a true auth error that requires user to reconnect.
 * Only resets connection for:
 * - 401 Unauthorized (token truly invalid)
 * - invalid_grant or token revocation errors
 * Does NOT reset for:
 * - 403 Forbidden (could be rate-limit, quota, or permission issue)
 * - Other transient errors
 */
async function handleCalendarAuthError(error: unknown, userId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorWithResponse = error as { response?: { status?: number }; message?: string };
  const status = errorWithResponse?.response?.status;
  const message = errorWithResponse?.message || '';

  // Only reset on 401 or explicit token revocation errors
  const isUnauthorized = status === 401;
  const isTokenRevoked = message.includes('invalid_grant') ||
    message.includes('Token has been expired or revoked') ||
    message.includes('Token has been revoked');

  // For 403, only reset if it's a token issue, not quota/rate-limit
  const is403TokenIssue = status === 403 && (
    message.includes('invalid_grant') ||
    message.includes('access_denied') ||
    message.includes('Token has been expired or revoked')
  );

  if (isUnauthorized || isTokenRevoked || is403TokenIssue) {
    calendarLog('AUTH_ERROR_DETECTED', userId, {
      status,
      message,
      action: 'RESETTING_CONNECTION',
    });

    // Only set flag to false, keep tokens for potential re-auth
    await db.collection(Collections.USERS).doc(userId).update({
      googleCalendarConnected: false,
    });

    calendarLog('CONNECTION_RESET', userId, { notifyingUser: true, tokensPreserved: true });

    // Notify user to reconnect
    await sendNotification(
      userId,
      '🔄 Calendar Reconnection Required',
      'Your calendar connection expired. Please reconnect in Settings.',
      createNotificationData(NotificationType.TASK_UPDATED, { action: 'calendar_reconnect' })
    );
    return true;
  }

  // Log non-auth errors but don't reset connection
  if (status === 403 || status === 429) {
    calendarLog('TRANSIENT_ERROR', userId, {
      status,
      message,
      action: 'NO_RESET',
      note: 'Rate-limit or quota error, will retry on next operation',
    });
  }

  return false;
}

/**
 * Create a Google Calendar event for a task.
 * Uses authenticated client with automatic token refresh.
 * 
 * @param userId - The user to create the calendar event for
 * @param taskId - The task ID (used for logging and optional task doc update)
 * @param title - Event title
 * @param subtitle - Event description
 * @param deadline - Event start time
 * @param skipTaskDocUpdate - If true, skip updating the task doc with calendarEventId
 *   (used for multi-assignee tasks where calendarEventId is stored per-assignment)
 */
export async function createCalendarEventForUser(
  userId: string,
  taskId: string,
  title: string,
  subtitle: string,
  deadline: Date,
  skipTaskDocUpdate = false,
  providedCalendar?: CalendarApi
): Promise<string | null> {
  // Check if user has calendar connected
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();

  if (!user?.googleCalendarConnected) {
    calendarLog('CREATE_EVENT', userId, {
      status: 'SKIPPED',
      reason: 'calendar_not_connected',
      taskId,
    });
    return null;
  }

  calendarLog('CREATE_EVENT', userId, {
    status: 'STARTING',
    taskId,
    title,
    deadline: deadline.toISOString(),
  });

  // Get authenticated client with token refresh support (if not provided)
  const calendar = providedCalendar || (await getAuthenticatedClient(userId))?.calendar;
  if (!calendar) {
    calendarLog('CREATE_EVENT', userId, {
      status: 'FAILED',
      reason: 'no_auth_client',
      taskId,
    });
    return null;
  }

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
          overrides: [
            { method: 'popup', minutes: 1440 }, // 24h before
            { method: 'popup', minutes: 360 }, // 6h before
            { method: 'popup', minutes: 60 }, // 1h before
          ],
        },
      },
    });

    const eventId = event.data.id;

    calendarLog('CREATE_EVENT', userId, {
      status: 'SUCCESS',
      taskId,
      eventId,
      title,
      deadline: deadline.toISOString(),
    });

    // Save event ID to task document (skip for multi-assignee tasks where
    // calendarEventId is stored per-assignment to avoid write contention)
    if (!skipTaskDocUpdate) {
      await db.collection(Collections.TASKS).doc(taskId).update({
        calendarEventId: eventId,
      });
      calendarLog('EVENT_ID_SAVED', userId, { taskId, eventId });
    } else {
      calendarLog('EVENT_ID_SKIP_TASK_DOC', userId, { taskId, eventId, reason: 'multi_assignee' });
    }

    return eventId ?? null;
  } catch (error) {
    // Check if auth error and reset connection
    const wasAuthError = await handleCalendarAuthError(error, userId);
    calendarError('CREATE_EVENT', userId, error, {
      taskId,
      title,
      wasAuthError,
    });
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
  newDeadline?: Date,
  newTitle?: string,
  newSubtitle?: string,
  providedCalendar?: CalendarApi
): Promise<boolean> {
  calendarLog('UPDATE_EVENT', userId, {
    status: 'STARTING',
    eventId,
    newDeadline: newDeadline?.toISOString(),
    newTitle,
  });

  // Get authenticated client with token refresh support (if not provided)
  const calendar = providedCalendar || (await getAuthenticatedClient(userId))?.calendar;
  if (!calendar) {
    calendarLog('UPDATE_EVENT', userId, {
      status: 'FAILED',
      reason: 'no_auth_client',
      eventId,
    });
    return false;
  }

  try {
    const requestBody: any = {};
    if (newDeadline) {
      const endTime = new Date(newDeadline.getTime() + 60 * 60 * 1000);
      requestBody.start = { dateTime: newDeadline.toISOString() };
      requestBody.end = { dateTime: endTime.toISOString() };
    }
    if (newTitle) {
      requestBody.summary = newTitle;
    }
    if (newSubtitle !== undefined) {
      requestBody.description = newSubtitle;
    }

    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody,
    });

    calendarLog('UPDATE_EVENT', userId, {
      status: 'SUCCESS',
      eventId,
      newDeadline: newDeadline?.toISOString(),
    });
    return true;
  } catch (error) {
    const wasAuthError = await handleCalendarAuthError(error, userId);
    calendarError('UPDATE_EVENT', userId, error, { eventId, wasAuthError });
    return false;
  }
}

/**
 * Delete a Google Calendar event.
 * Uses authenticated client with automatic token refresh.
 */
export async function deleteCalendarEvent(
  userId: string,
  eventId: string,
  providedCalendar?: CalendarApi
): Promise<boolean> {
  calendarLog('DELETE_EVENT', userId, { status: 'STARTING', eventId });

  // Get authenticated client with token refresh support (if not provided)
  const calendar = providedCalendar || (await getAuthenticatedClient(userId))?.calendar;
  if (!calendar) {
    calendarLog('DELETE_EVENT', userId, {
      status: 'FAILED',
      reason: 'no_auth_client',
      eventId,
    });
    return false;
  }

  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });

    calendarLog('DELETE_EVENT', userId, { status: 'SUCCESS', eventId });
    return true;
  } catch (error) {
    // Check if event was already deleted (404) - not really an error
    const errorWithResponse = error as { response?: { status?: number } };
    if (errorWithResponse?.response?.status === 404) {
      calendarLog('DELETE_EVENT', userId, {
        status: 'SUCCESS',
        eventId,
        note: 'already_deleted_404',
      });
      return true; // Consider it successful - event is gone
    }

    const wasAuthError = await handleCalendarAuthError(error, userId);
    calendarError('DELETE_EVENT', userId, error, { eventId, wasAuthError });
    return false;
  }
}

// eslint-disable-next-line jsdoc/require-jsdoc
export async function deleteAllUserCalendarEvents(userId: string): Promise<void> {
  calendarLog('DELETE_ALL_EVENTS', userId, { status: 'STARTING' });

  // Get authenticated client ONCE for all deletions
  const authResult = await getAuthenticatedClient(userId);
  if (!authResult) {
    calendarLog('DELETE_ALL_EVENTS', userId, {
      status: 'FAILED',
      reason: 'no_auth_client',
    });
    return;
  }
  const { calendar } = authResult;

  let deletedCount = 0;

  // 1. Handle legacy single-assignee tasks
  // OPTIMIZATION: Only fetch those that have a calendarEventId
  const legacyTasksSnapshot = await db.collection(Collections.TASKS)
    .where('assignedTo', '==', userId)
    .where('calendarEventId', '>=', '') // Efficient check for non-empty string
    .get();

  const legacyDeletes = legacyTasksSnapshot.docs.map(async (taskDoc) => {
    const task = taskDoc.data();
    if (task.calendarEventId) {
      const deleted = await deleteCalendarEvent(userId, task.calendarEventId, calendar);
      if (deleted) {
        deletedCount++;
        await taskDoc.ref.update({ calendarEventId: null });
      }
    }
  });

  // 2. Handle multi-assignee tasks
  const assignmentsSnapshot = await db.collectionGroup(Collections.ASSIGNMENTS)
    .where('userId', '==', userId)
    .where('calendarEventId', '>=', '')
    .get();

  const assignmentDeletes = assignmentsSnapshot.docs.map(async (assignmentDoc) => {
    const assignment = assignmentDoc.data();
    if (assignment.calendarEventId) {
      const deleted = await deleteCalendarEvent(userId, assignment.calendarEventId, calendar);
      if (deleted) {
        deletedCount++;
        await assignmentDoc.ref.update({ calendarEventId: null });
      }
    }
  });

  // Execute all deletions in parallel (with controlled concurrency if needed, but here simple Promise.all)
  // We use Promise.allSettled to ensure failure of one doesn't stop others
  await Promise.allSettled([...legacyDeletes, ...assignmentDeletes]);

  calendarLog('DELETE_ALL_EVENTS', userId, {
    status: 'COMPLETE',
    totalDeleted: deletedCount,
  });
}

/**
 * Disconnect Google Calendar - Callable Cloud Function
 * Deletes all calendar events but preserves tokens for seamless reconnection.
 */
export const disconnectCalendar = onCall(
  callableConfig,
  async (request: CallableRequest<unknown>) => {
    const context = { auth: request.auth };
    const userId = validateAuthenticated(context);
    calendarLog('DISCONNECT', userId, { status: 'STARTING' });

    // Check current connection status first
    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    const user = userDoc.data();

    if (!user) {
      calendarLog('DISCONNECT', userId, { status: 'FAILED', reason: 'user_not_found' });
      throw new HttpsError('not-found', 'User not found');
    }

    // If already disconnected, return early (idempotent)
    if (!user.googleCalendarConnected) {
      calendarLog('DISCONNECT', userId, { status: 'ALREADY_DISCONNECTED' });
      return { success: true, message: 'Calendar already disconnected' };
    }

    // IMPORTANT: Delete events BEFORE setting flag to false
    // This is because getAuthenticatedClient() checks the flag and returns null if false
    // If we set flag first, cleanup would fail!
    await deleteAllUserCalendarEvents(userId);

    // Only set flag to false AFTER cleanup completes
    // Preserve tokens for seamless reconnection
    await db.collection(Collections.USERS).doc(userId).update({
      googleCalendarConnected: false,
    });

    calendarLog('DISCONNECT', userId, { status: 'SUCCESS', tokensPreserved: true });
    return { success: true, message: 'Calendar disconnected successfully' };
  }
);

/**
 * Sync all existing ongoing tasks to Google Calendar
 * Called when user first connects their calendar to sync existing tasks
 * Handles both single-assignee (legacy) and multi-assignee tasks
 */
async function syncExistingTasksToCalendar(userId: string): Promise<number> {
  calendarLog('SYNC_EXISTING_TASKS', userId, { status: 'STARTING' });

  // Get authenticated client ONCE for all syncs
  const authResult = await getAuthenticatedClient(userId);
  if (!authResult) {
    calendarLog('SYNC_EXISTING_TASKS', userId, { status: 'FAILED', reason: 'no_auth_client' });
    return 0;
  }
  const { calendar } = authResult;

  let syncedCount = 0;

  // 1. Handle legacy single-assignee tasks
  const legacyTasksSnapshot = await db.collection(Collections.TASKS)
    .where('assignedTo', '==', userId)
    .where('status', '==', TaskStatus.ONGOING)
    .get();

  const legacySyncs = legacyTasksSnapshot.docs.map(async (taskDoc) => {
    const task = taskDoc.data();
    if (task.calendarEventId) return;

    const deadline = task.deadline?.toDate();
    if (deadline && deadline > new Date()) {
      const eventId = await createCalendarEventForUser(
        userId,
        taskDoc.id,
        task.title,
        task.subtitle || '',
        deadline,
        false, // updateTaskDoc
        calendar
      );
      if (eventId) syncedCount++;
    }
  });

  // 2. Handle multi-assignee tasks
  const assignmentsSnapshot = await db.collectionGroup(Collections.ASSIGNMENTS)
    .where('userId', '==', userId)
    .where('status', '==', TaskAssignmentStatus.ONGOING)
    .get();

  const assignmentSyncs = assignmentsSnapshot.docs.map(async (assignmentDoc) => {
    const assignment = assignmentDoc.data();
    if (assignment.calendarEventId) return;

    const taskId = assignmentDoc.ref.parent.parent?.id;
    if (!taskId) return;

    const taskDoc = await db.collection(Collections.TASKS).doc(taskId).get();
    const task = taskDoc.data();

    if (!task || task.status !== TaskStatus.ONGOING) return;

    const deadline = task.deadline?.toDate();
    if (deadline && deadline > new Date()) {
      const eventId = await createCalendarEventForUser(
        userId,
        taskId,
        task.title,
        task.subtitle || '',
        deadline,
        true, // skipTaskDocUpdate (assignment handles it)
        calendar
      );
      if (eventId) {
        await assignmentDoc.ref.update({ calendarEventId: eventId });
        syncedCount++;
      }
    }
  });

  // Execute all syncs in parallel
  await Promise.allSettled([...legacySyncs, ...assignmentSyncs]);

  calendarLog('SYNC_EXISTING_TASKS', userId, {
    status: 'COMPLETE',
    syncedCount,
  });

  return syncedCount;
}

/**
 * Verify that the calendar access token is valid by making a test API call.
 * This prevents false positive "connected" status when tokens don't actually work.
 * 
 * @param accessToken - The access token to verify
 * @returns Object with success status and error details if failed
 */
async function verifyCalendarAccess(accessToken: string): Promise<{ success: boolean; error?: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { success: false, error: 'OAuth credentials not configured' };
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, '');
    oauth2Client.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Make a lightweight test call using events.list (works with calendar.events scope)
    // Note: calendar.settings.list requires broader scope that app doesn't have
    await calendar.events.list({
      calendarId: 'primary',
      maxResults: 1,
      timeMin: new Date().toISOString(),
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Exchange Calendar Auth Code for Tokens - Callable Cloud Function
 *
 * Receives a serverAuthCode from the mobile app and exchanges it for
 * access_token and refresh_token. The refresh_token is stored in Firestore
 * so the backend can refresh tokens automatically without user interaction.
 *
 * IMPORTANT: This function now VERIFIES the tokens work before setting
 * googleCalendarConnected = true, preventing false positive connections.
 *
 * This is the key to making calendar integration work reliably:
 * - Mobile app gets serverAuthCode via GoogleSignIn (no refresh token exposed)
 * - Backend exchanges it for REAL refresh_token from Google
 * - Backend VERIFIES the token works by making a test API call
 * - Only then marks calendar as connected
 * - Backend can now refresh access tokens anytime (even when app is closed)
 */
export const exchangeCalendarAuthCode = onCall(
  callableConfig,
  async (request: CallableRequest<{ authCode: string }>) => {
    const data = request.data;
    const context = { auth: request.auth };
    const userId = validateAuthenticated(context);
    calendarLog('EXCHANGE_AUTH_CODE', userId, {
      status: 'STARTING',
      authCodeLength: data.authCode?.length,
    });

    const authCode = data.authCode;
    if (!authCode || typeof authCode !== 'string') {
      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'FAILED',
        reason: 'invalid_auth_code',
      });
      throw new HttpsError('invalid-argument', 'authCode is required');
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      calendarError('EXCHANGE_AUTH_CODE', userId, 'Missing OAuth config', {
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
      });
      throw new HttpsError(
        'failed-precondition',
        'Server OAuth credentials not configured'
      );
    }

    try {
      // Create OAuth2 client - empty redirect URI for mobile auth code flow
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, '');

      // Exchange the auth code for tokens
      // This is where we get the REAL refresh_token!
      calendarLog('EXCHANGE_AUTH_CODE', userId, { status: 'EXCHANGING_TOKEN' });
      const { tokens } = await oauth2Client.getToken(authCode);

      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'TOKEN_RECEIVED',
        hasAccessToken: !!tokens.access_token,
        hasRefreshToken: !!tokens.refresh_token,
        accessTokenPreview: tokens.access_token?.substring(0, 20) + '...',
        tokenType: tokens.token_type,
        expiryDate: tokens.expiry_date,
      });

      if (!tokens.access_token) {
        calendarLog('EXCHANGE_AUTH_CODE', userId, {
          status: 'FAILED',
          reason: 'no_access_token_returned',
        });
        throw new HttpsError(
          'internal',
          'Failed to obtain access token from Google'
        );
      }

      // CRITICAL: Verify the token actually works before marking as connected
      // This prevents false positive "connected" status
      calendarLog('EXCHANGE_AUTH_CODE', userId, { status: 'VERIFYING_TOKEN' });
      const verificationResult = await verifyCalendarAccess(tokens.access_token);

      if (!verificationResult.success) {
        calendarLog('EXCHANGE_AUTH_CODE', userId, {
          status: 'VERIFICATION_FAILED',
          reason: verificationResult.error,
        });
        throw new HttpsError(
          'internal',
          `Calendar verification failed: ${verificationResult.error}. Please try connecting again.`
        );
      }

      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'VERIFICATION_SUCCESS',
        note: 'Token verified - calendar API is accessible',
      });

      // Prepare token data for Firestore
      const updateData: Record<string, unknown> = {
        googleAccessToken: tokens.access_token,
      };

      // Only store refresh_token if we got one
      // (Google only returns refresh_token on first consent)
      if (tokens.refresh_token) {
        updateData.googleRefreshToken = tokens.refresh_token;
        calendarLog('EXCHANGE_AUTH_CODE', userId, {
          storingRefreshToken: true,
          refreshTokenPreview: tokens.refresh_token.substring(0, 15) + '...',
        });
      } else {
        calendarLog('EXCHANGE_AUTH_CODE', userId, {
          storingRefreshToken: false,
          note: 'No refresh_token received (may already exist in Firestore)',
        });
      }

      // CRITICAL: Only set googleCalendarConnected = true AFTER verification passes
      // This is the key fix to prevent false positive connections
      updateData.googleCalendarConnected = true;

      await db.collection(Collections.USERS).doc(userId).update(updateData);
      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'TOKENS_SAVED_TO_FIRESTORE',
        savedAccessToken: true,
        savedRefreshToken: !!tokens.refresh_token,
        connectedFlagSet: true,
      });

      // Sync existing ongoing tasks to calendar (don't await - run in background)
      // This ensures existing tasks appear in the calendar after connection
      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'STARTING_BACKGROUND_SYNC',
      });
      syncExistingTasksToCalendar(userId).catch((err) => {
        calendarError('SYNC_EXISTING_TASKS', userId, err, { source: 'background' });
      });

      calendarLog('EXCHANGE_AUTH_CODE', userId, {
        status: 'SUCCESS',
        hasRefreshToken: !!tokens.refresh_token,
      });

      return {
        success: true,
        message: 'Calendar connected successfully',
        hasRefreshToken: !!tokens.refresh_token,
      };
    } catch (error) {
      calendarError('EXCHANGE_AUTH_CODE', userId, error, {});

      // Check for common errors
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('invalid_grant')) {
        throw new HttpsError(
          'invalid-argument',
          'Auth code expired or already used. Please try connecting again.'
        );
      }

      throw new HttpsError(
        'internal',
        `Failed to exchange auth code: ${errorMessage}`
      );
    }
  }
);

/**
 * Reconnect Google Calendar using existing refresh token.
 * 
 * This avoids the need for the user to go through the OAuth flow again
 * if we already have valid tokens stored.
 */
export const reconnectCalendar = onCall(
  callableConfig,
  async (request: CallableRequest<unknown>) => {
    const context = { auth: request.auth };
    const userId = validateAuthenticated(context);

    calendarLog('RECONNECT_CALENDAR', userId, {
      status: 'STARTING',
    });

    try {
      // 1. Check for existing tokens
      const userDoc = await db.collection(Collections.USERS).doc(userId).get();
      const user = userDoc.data();

      if (!user?.googleRefreshToken) {
        calendarLog('RECONNECT_CALENDAR', userId, {
          status: 'FAILED',
          reason: 'no_refresh_token',
        });
        return {
          success: false,
          message: 'No saved credentials found. Please connect as a new user.',
          requiresReauth: true,
        };
      }

      // 2. Refresh the access token using the stored refresh token
      // We do this by creating a client with the refresh token and forcing a refresh
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new HttpsError('failed-precondition', 'Server OAuth credentials not configured');
      }

      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, '');
      oauth2Client.setCredentials({
        refresh_token: user.googleRefreshToken,
      });

      // Force a refresh explicitly
      const { credentials } = await oauth2Client.refreshAccessToken();
      const newAccessToken = credentials.access_token;

      if (!newAccessToken) {
        throw new Error('Failed to refresh access token');
      }

      // 3. Verify the new token actually works
      const verificationResult = await verifyCalendarAccess(newAccessToken);
      if (!verificationResult.success) {
        // If verification fails with a valid refresh token, it usually means 
        // the user revoked access in their Google Account settings.
        calendarLog('RECONNECT_CALENDAR', userId, {
          status: 'VERIFICATION_FAILED',
          reason: verificationResult.error,
        });

        // Clear invalid tokens so UI knows to force re-auth next time
        await db.collection(Collections.USERS).doc(userId).update({
          googleRefreshToken: admin.firestore.FieldValue.delete(),
          googleAccessToken: admin.firestore.FieldValue.delete(),
          googleCalendarConnected: false,
        });

        return {
          success: false,
          message: 'Connection revoked. Please reconnect your account.',
          requiresReauth: true,
        };
      }

      // 4. Success - Update Firestore
      await db.collection(Collections.USERS).doc(userId).update({
        googleAccessToken: newAccessToken,
        googleCalendarConnected: true,
      });

      // 5. Trigger sync
      calendarLog('RECONNECT_CALENDAR', userId, {
        status: 'STARTING_BACKGROUND_SYNC',
      });
      syncExistingTasksToCalendar(userId).catch((err) => {
        calendarError('SYNC_EXISTING_TASKS', userId, err, { source: 'background_reconnect' });
      });

      calendarLog('RECONNECT_CALENDAR', userId, { status: 'SUCCESS' });

      return {
        success: true,
        message: 'Calendar reconnected successfully',
        requiresReauth: false,
      };

    } catch (error) {
      calendarError('RECONNECT_CALENDAR', userId, error, {});

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // If it's a token revocation (invalid_grant) during refresh
      if (errorMessage.includes('invalid_grant') ||
        errorMessage.includes('revoked')) {

        // Clean up invalid tokens
        await db.collection(Collections.USERS).doc(userId).update({
          googleRefreshToken: admin.firestore.FieldValue.delete(),
          googleAccessToken: admin.firestore.FieldValue.delete(),
          googleCalendarConnected: false,
        });

        return {
          success: false,
          message: 'Connection expired. Please connect again.',
          requiresReauth: true,
        };
      }

      throw new HttpsError('internal', `Reconnection failed: ${errorMessage}`);
    }
  }
);
