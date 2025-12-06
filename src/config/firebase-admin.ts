import * as admin from 'firebase-admin';

// Initialize Firebase Admin SDK
// When deployed to Firebase Functions, this will use default credentials
if (!admin.apps.length) {
  admin.initializeApp();
}

export const db = admin.firestore();
export const auth = admin.auth();
export const messaging = admin.messaging();

export { admin };
