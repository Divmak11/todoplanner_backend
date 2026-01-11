import * as functions from 'firebase-functions/v1';
import { admin, db, auth } from '../config/firebase-admin';
import {
  Collections,
  UserRole,
  UserStatus,
  ApprovalRequestType,
  ApprovalStatus,
  NotificationType,
  InviteStatus,
} from '../config/constants';
import { notifySuperAdmins, createNotificationData, sendNotification } from '../services/notificationService';
import { sendInviteAcceptedEmail } from '../services/emailService';

/**
 * Trigger: Create user profile when a new user signs up
 * Sets initial role and status based on configuration
 */
export const createUserProfile = functions.region('asia-south1').auth.user().onCreate(async (user) => {
  // Get super admin emails from environment variable (comma-separated for multiple admins)
  const superAdminEmailsStr = process.env.SUPER_ADMIN_EMAILS || '';
  const superAdminEmails = superAdminEmailsStr
    .split(',')
    .map((email: string) => email.trim().toLowerCase())
    .filter((email: string) => email.length > 0);

  const isSuperAdmin = user.email ? superAdminEmails.includes(user.email.toLowerCase()) : false;
  const role = isSuperAdmin ? UserRole.SUPER_ADMIN : UserRole.MEMBER;
  let status = isSuperAdmin ? UserStatus.ACTIVE : UserStatus.PENDING;
  let inviteData: any = null;

  // Check for pending invite (case-insensitive email match)
  if (!isSuperAdmin && user.email) {
    const invitesQuery = await db.collection(Collections.INVITES)
      .where('email', '==', user.email.toLowerCase())
      .where('status', '==', InviteStatus.PENDING)
      .limit(1)
      .get();

    if (!invitesQuery.empty) {
      const inviteDoc = invitesQuery.docs[0];
      const invite = inviteDoc.data();

      // Check if invite is not expired
      const now = new Date();
      const expiresAt = invite.expiresAt.toDate();

      if (expiresAt > now) {
        // Auto-approve the user
        status = UserStatus.ACTIVE;
        inviteData = {
          inviteId: inviteDoc.id,
          invitedBy: invite.invitedBy,
        };

        // Mark invite as accepted
        await inviteDoc.ref.update({
          status: InviteStatus.ACCEPTED,
          acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
          acceptedBy: user.uid,
        });

        console.log(`User ${user.uid} auto-approved via invite from ${invite.invitedBy}`);
      } else {
        // Mark expired invite
        await inviteDoc.ref.update({
          status: InviteStatus.EXPIRED,
        });
        console.log(`Invite for ${user.email} was expired`);
      }
    }
  }

  // Create user document
  const userData: Record<string, any> = {
    id: user.uid,
    name: user.displayName || user.email?.split('@')[0] || 'User',
    email: user.email || '',
    role,
    teamIds: [],
    status,
    needsOnboarding: true, // Flag to indicate user needs to set their preferred name
    googleCalendarConnected: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
  };

  // If auto-approved via invite, add approval metadata
  if (inviteData) {
    userData.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    userData.approvedBy = inviteData.invitedBy;
  }

  await db.collection(Collections.USERS).doc(user.uid).set(userData);

  // Set custom claims for the user
  await auth.setCustomUserClaims(user.uid, { role });

  // If auto-approved via invite, notify inviter
  if (inviteData) {
    await sendNotification(
      inviteData.invitedBy,
      'Invite Accepted!',
      `${userData.name} has joined and is now an active member`,
      createNotificationData(NotificationType.INVITE_ACCEPTED, { userId: user.uid })
    );

    // Send email notification to inviter
    const inviterDoc = await db.collection(Collections.USERS).doc(inviteData.invitedBy).get();
    if (inviterDoc.exists) {
      await sendInviteAcceptedEmail(
        inviterDoc.data()!.email,
        user.email || '',
        userData.name
      );
    }
  } else if (status === UserStatus.PENDING) {
    // If pending (no invite), create approval request and notify admins
    await db.collection(Collections.APPROVAL_REQUESTS).add({
      type: ApprovalRequestType.USER_ACCESS,
      requesterId: user.uid,
      targetId: user.uid,
      payload: { email: user.email },
      status: ApprovalStatus.PENDING,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify Super Admins
    await notifySuperAdmins(
      'New Approval Request',
      `${user.email} is waiting for approval`,
      createNotificationData(NotificationType.NEW_PENDING_USER, { userId: user.uid })
    );
  }

  console.log(`User profile created for ${user.uid} with role ${role} and status ${status}`);
});

/**
 * Trigger: Cleanup when a user is deleted from Firebase Auth
 */
export const onUserDeleted = functions.region('asia-south1').auth.user().onDelete(async (user) => {
  const batch = db.batch();

  // Delete user document
  batch.delete(db.collection(Collections.USERS).doc(user.uid));

  // Delete any pending approval requests for this user
  const approvalRequests = await db.collection(Collections.APPROVAL_REQUESTS)
    .where('requesterId', '==', user.uid)
    .get();

  approvalRequests.docs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
  console.log(`Cleaned up data for deleted user ${user.uid}`);
});
