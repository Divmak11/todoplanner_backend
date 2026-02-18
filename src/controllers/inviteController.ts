import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';
import { admin, db } from '../config/firebase-admin';
import { Collections, InviteStatus, NotificationType } from '../config/constants';
import { validateSuperAdminAsync, validateRequiredString, validateAuthenticated } from '../utils/validators';
import { sendInviteEmail, sendInviteAcceptedEmail } from '../services/emailService';
import { sendNotification, createNotificationData } from '../services/notificationService';
import { SendInviteInput, ResendInviteInput, CancelInviteInput } from '../types';

// 2nd Gen configuration for callable functions
const callableConfig = { region: 'asia-south1', concurrency: 80 };

// Invite validity period: 7 days
const INVITE_VALIDITY_DAYS = 7;

/**
 * Generate a unique invite token
 * @return {string} A 64-character hex string token
 */
function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Get expiration timestamp for invite
 * @return {admin.firestore.Timestamp} Timestamp set to 7 days from now
 */
function getExpirationTimestamp(): admin.firestore.Timestamp {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITE_VALIDITY_DAYS);
  return admin.firestore.Timestamp.fromDate(expiresAt);
}

/**
 * Send an invite to a new user
 * Only Super Admin or Team Admin can send invites
 */
export const sendInvite = onCall(
  callableConfig,
  async (request: CallableRequest<SendInviteInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    // Validate caller is super admin
    const inviterId = await validateSuperAdminAsync(context);
    const email = validateRequiredString(data.email, 'email').toLowerCase().trim();
    const teamId = data.teamId;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      throw new HttpsError('invalid-argument', 'Invalid email format');
    }

    // Check if user already exists with this email
    const existingUsers = await db.collection(Collections.USERS)
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!existingUsers.empty) {
      throw new HttpsError(
        'already-exists',
        'A user with this email already exists'
      );
    }

    // Check if there's already a pending invite for this email
    const existingInvites = await db.collection(Collections.INVITES)
      .where('email', '==', email)
      .where('status', '==', InviteStatus.PENDING)
      .limit(1)
      .get();

    if (!existingInvites.empty) {
      throw new HttpsError(
        'already-exists',
        'An invite has already been sent to this email'
      );
    }

    // Validate team if provided
    let teamName: string | undefined;
    if (teamId) {
      const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
      if (!teamDoc.exists) {
        throw new HttpsError('not-found', 'Team not found');
      }
      teamName = teamDoc.data()!.name;
    }

    // Get inviter info
    const inviterDoc = await db.collection(Collections.USERS).doc(inviterId).get();
    const inviterName = inviterDoc.exists ? inviterDoc.data()!.name : 'Admin';

    // Generate unique token
    const token = generateInviteToken();

    // Create invite document
    const inviteRef = await db.collection(Collections.INVITES).add({
      email,
      invitedBy: inviterId,
      teamId: teamId || null,
      token,
      status: InviteStatus.PENDING,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: getExpirationTimestamp(),
    });

    // Send invite email
    try {
      await sendInviteEmail(email, inviterName, token, teamName);
      console.log(`Invite sent successfully to ${email}`);
    } catch (emailError: any) {
      // If email sending fails, delete the invite and throw error
      await inviteRef.delete();
      console.error(`Failed to send invite to ${email}:`, emailError.message);
      throw new HttpsError(
        'internal',
        `Failed to send invite email: ${emailError.message}`
      );
    }

    return {
      success: true,
      inviteId: inviteRef.id,
      message: 'Invite sent successfully',
    };
  }
);

/**
 * Resend an invite email
 * Only Super Admin can resend invites
 */
export const resendInvite = onCall(
  callableConfig,
  async (request: CallableRequest<ResendInviteInput>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const inviterId = await validateSuperAdminAsync(context);
    const inviteId = validateRequiredString(data.inviteId, 'inviteId');

    // Get invite
    const inviteDoc = await db.collection(Collections.INVITES).doc(inviteId).get();
    if (!inviteDoc.exists) {
      throw new HttpsError('not-found', 'Invite not found');
    }

    const invite = inviteDoc.data()!;

    if (invite.status !== InviteStatus.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        `Cannot resend invite with status: ${invite.status}`
      );
    }

    // Get inviter info
    const inviterDoc = await db.collection(Collections.USERS).doc(inviterId).get();
    const inviterName = inviterDoc.exists ? inviterDoc.data()!.name : 'Admin';

    // Get team name if applicable
    let teamName: string | undefined;
    if (invite.teamId) {
      const teamDoc = await db.collection(Collections.TEAMS).doc(invite.teamId).get();
      if (teamDoc.exists) {
        teamName = teamDoc.data()!.name;
      }
    }

    // Generate new token and extend expiration
    const newToken = generateInviteToken();

    await inviteDoc.ref.update({
      token: newToken,
      expiresAt: getExpirationTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Send email
    const emailSent = await sendInviteEmail(invite.email, inviterName, newToken, teamName);

    return {
      success: true,
      message: emailSent ? 'Invite resent successfully' : 'Invite updated (email not configured)',
    };
  }
);

/**
 * Cancel a pending invite
 * Only Super Admin can cancel invites
 */
export const cancelInvite = onCall(
  callableConfig,
  async (request: CallableRequest<CancelInviteInput>) => {
    const context = { auth: request.auth };
    const data = request.data;

    await validateSuperAdminAsync(context);
    const inviteId = validateRequiredString(data.inviteId, 'inviteId');

    const inviteDoc = await db.collection(Collections.INVITES).doc(inviteId).get();
    if (!inviteDoc.exists) {
      throw new HttpsError('not-found', 'Invite not found');
    }

    const invite = inviteDoc.data()!;

    if (invite.status !== InviteStatus.PENDING) {
      throw new HttpsError(
        'failed-precondition',
        `Cannot cancel invite with status: ${invite.status}`
      );
    }

    await inviteDoc.ref.update({
      status: InviteStatus.CANCELLED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, message: 'Invite cancelled' };
  }
);

/**
 * Validate an invite token (called when user opens invite link)
 * Public function - no auth required
 */
export const validateInviteToken = onCall(
  callableConfig,
  async (request: CallableRequest<{ token: string }>) => {
    const data = request.data;
    const token = validateRequiredString(data.token, 'token');

    const invites = await db.collection(Collections.INVITES)
      .where('token', '==', token)
      .where('status', '==', InviteStatus.PENDING)
      .limit(1)
      .get();

    if (invites.empty) {
      throw new HttpsError('not-found', 'Invalid or expired invite');
    }

    const invite = invites.docs[0].data();
    const now = admin.firestore.Timestamp.now();

    // Check if expired
    if (invite.expiresAt.toMillis() < now.toMillis()) {
      // Mark as expired
      await invites.docs[0].ref.update({ status: InviteStatus.EXPIRED });
      throw new HttpsError('deadline-exceeded', 'Invite has expired');
    }

    // Get team info if applicable
    let teamName: string | undefined;
    if (invite.teamId) {
      const teamDoc = await db.collection(Collections.TEAMS).doc(invite.teamId).get();
      if (teamDoc.exists) {
        teamName = teamDoc.data()!.name;
      }
    }

    return {
      valid: true,
      email: invite.email,
      teamId: invite.teamId || null,
      teamName: teamName || null,
    };
  }
);

/**
 * Accept an invite after user signs up
 * Called automatically when a user with an invite email signs up
 */
export const acceptInvite = onCall(
  callableConfig,
  async (request: CallableRequest<{ token: string }>) => {
    const data = request.data;
    const context = { auth: request.auth };

    const userId = validateAuthenticated(context);
    const token = validateRequiredString(data.token, 'token');

    // Get invite by token
    const invites = await db.collection(Collections.INVITES)
      .where('token', '==', token)
      .where('status', '==', InviteStatus.PENDING)
      .limit(1)
      .get();

    if (invites.empty) {
      throw new HttpsError('not-found', 'Invalid or expired invite');
    }

    const inviteDoc = invites.docs[0];
    const invite = inviteDoc.data();

    // Verify email matches
    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User not found');
    }

    const user = userDoc.data()!;
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new HttpsError(
        'permission-denied',
        'Email does not match invite'
      );
    }

    const batch = db.batch();

    // Update invite status
    batch.update(inviteDoc.ref, {
      status: InviteStatus.ACCEPTED,
      acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
      acceptedBy: userId,
    });

    // Auto-approve user (NO team assignment - admin will add manually if needed)
    const userUpdates: Record<string, unknown> = {
      status: 'active',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: invite.invitedBy,
    };

    batch.update(userDoc.ref, userUpdates);

    await batch.commit();

    // Notify inviter
    await sendNotification(
      invite.invitedBy,
      'Invitation Accepted',
      `${user.name} has accepted your invitation`,
      createNotificationData(NotificationType.INVITE_ACCEPTED, { userId })
    );

    // Send email notification to inviter
    const inviterDoc = await db.collection(Collections.USERS).doc(invite.invitedBy).get();
    if (inviterDoc.exists) {
      await sendInviteAcceptedEmail(
        inviterDoc.data()!.email,
        user.email,
        user.name
      );
    }

    return {
      success: true,
      message: 'Invite accepted successfully - you are now an active member',
      autoApproved: true,
    };
  }
);

/**
 * Get all invites (for admin view)
 * Only Super Admin can view all invites
 * Also auto-updates expired pending invites
 */
export const getInvites = onCall(
  callableConfig,
  async (request: CallableRequest<{ status?: string }>) => {
    const data = request.data;
    const context = { auth: request.auth };

    await validateSuperAdminAsync(context);

    let query: admin.firestore.Query = db.collection(Collections.INVITES)
      .orderBy('createdAt', 'desc')
      .limit(100);

    if (data.status) {
      query = query.where('status', '==', data.status);
    }

    const invites = await query.get();
    const now = admin.firestore.Timestamp.now();
    const batch = db.batch();
    let hasUpdates = false;

    // Auto-update expired pending invites
    const processedInvites = invites.docs.map((doc) => {
      const invite = doc.data();
      let status = invite.status;

      // Check if pending invite has expired
      if (status === InviteStatus.PENDING && invite.expiresAt) {
        const expiresAt = invite.expiresAt as admin.firestore.Timestamp;
        if (expiresAt.toMillis() < now.toMillis()) {
          // Mark as expired in batch
          batch.update(doc.ref, {
            status: InviteStatus.EXPIRED,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          status = InviteStatus.EXPIRED;
          hasUpdates = true;
        }
      }

      return {
        id: doc.id,
        ...invite,
        status, // Use the potentially updated status
        createdAt: invite.createdAt?.toDate?.()?.toISOString(),
        expiresAt: invite.expiresAt?.toDate?.()?.toISOString(),
        acceptedAt: invite.acceptedAt?.toDate?.()?.toISOString(),
      };
    });

    // Commit batch updates if any invites were marked as expired
    if (hasUpdates) {
      await batch.commit();
    }

    return { invites: processedInvites };
  }
);
