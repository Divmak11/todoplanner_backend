import { admin, db, messaging } from '../config/firebase-admin';
import { Collections, NotificationTypeType } from '../config/constants';

interface NotificationData {
  [key: string]: string;
}

/**
 * Save notification to Firestore for Activity tab display
 */
async function saveNotificationToFirestore(
  userId: string,
  type: NotificationTypeType,
  title: string,
  message: string,
  taskId?: string
): Promise<void> {
  try {
    await db.collection('notifications').add({
      userId,
      type,
      title,
      message,
      taskId: taskId || null,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`Activity log saved for user ${userId}: ${title}`);
  } catch (error) {
    console.error(`Failed to save activity log for user ${userId}:`, error);
  }
}

export async function sendNotification(
  userId: string,
  title: string,
  body: string,
  data?: NotificationData
): Promise<void> {
  // Extract type and taskId from data for activity log
  const notificationType = data?.type as NotificationTypeType | undefined;
  const taskId = data?.taskId;

  // Save to Firestore for Activity tab (always, even if no FCM token)
  if (notificationType) {
    await saveNotificationToFirestore(userId, notificationType, title, body, taskId);
  }

  // Send push notification via FCM
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  const user = userDoc.data();

  if (!user || !user.fcmToken) {
    console.log(`No FCM token for user ${userId}, skipping push notification`);
    return;
  }

  try {
    await messaging.send({
      token: user.fcmToken,
      notification: { title, body },
      data: {
        ...data,
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'todo_planner_channel',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });
    console.log(`Push notification sent to user ${userId}: ${title}`);
  } catch (error) {
    console.error(`Failed to send push notification to user ${userId}:`, error);
  }
}

export async function sendMulticastNotification(
  userIds: string[],
  title: string,
  body: string,
  data?: NotificationData
): Promise<void> {
  if (userIds.length === 0) return;

  // Extract type and taskId from data for activity log
  const notificationType = data?.type as NotificationTypeType | undefined;
  const taskId = data?.taskId;

  // Save to Firestore for Activity tab for ALL users (always, even if no FCM token)
  if (notificationType) {
    const activityPromises = userIds.map((userId) =>
      saveNotificationToFirestore(userId, notificationType, title, body, taskId)
    );
    await Promise.all(activityPromises);
  }

  // Batch get users in chunks of 10 (Firestore limit for 'in' queries)
  const tokens: string[] = [];
  const chunks = chunkArray(userIds, 10);

  for (const chunk of chunks) {
    const userDocs = await db.collection(Collections.USERS)
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();

    userDocs.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const token = doc.data().fcmToken;
      if (token) tokens.push(token);
    });
  }

  if (tokens.length === 0) {
    console.log('No FCM tokens found for users, skipping multicast notification');
    return;
  }

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        ...data,
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'todo_planner_channel',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    });

    console.log(`Multicast notification sent: ${response.successCount} successful, ${response.failureCount} failed`);
  } catch (error) {
    console.error('Failed to send multicast notification:', error);
  }
}

export async function notifySuperAdmins(
  title: string,
  body: string,
  data?: NotificationData
): Promise<void> {
  const adminsSnapshot = await db.collection(Collections.USERS)
    .where('role', '==', 'super_admin')
    .get();

  const adminIds: string[] = [];
  adminsSnapshot.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
    adminIds.push(doc.id);
  });

  if (adminIds.length === 0) {
    console.log('No Super Admins found');
    return;
  }

  await sendMulticastNotification(adminIds, title, body, data);
}


export function createNotificationData(
  type: NotificationTypeType,
  additionalData?: Record<string, string>
): NotificationData {
  return {
    type,
    ...additionalData,
  };
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
