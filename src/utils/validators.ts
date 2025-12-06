import * as functions from 'firebase-functions';
import { db } from '../config/firebase-admin';
import { UserRole, UserRoleType, Collections } from '../config/constants';

/**
 * Validates that a user is authenticated
 */
export function validateAuthenticated(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
  }
  return context.auth.uid;
}

/**
 * Check if user is super admin using custom claims with Firestore fallback
 */
export async function isSuperAdminWithFallback(
  context: functions.https.CallableContext,
  userId: string
): Promise<boolean> {
  // Check custom claims first
  if (context.auth?.token?.role === UserRole.SUPER_ADMIN) {
    return true;
  }

  // Fallback: Check Firestore document
  const userDoc = await db.collection(Collections.USERS).doc(userId).get();
  if (userDoc.exists && userDoc.data()?.role === UserRole.SUPER_ADMIN) {
    return true;
  }

  return false;
}

/**
 * Validates that a user is a Super Admin (sync version - uses custom claims only)
 * For async version with Firestore fallback, use isSuperAdminWithFallback
 */
export function validateSuperAdmin(context: functions.https.CallableContext): string {
  const uid = validateAuthenticated(context);

  // Check custom claims for role
  const role = context.auth?.token?.role;
  if (role !== UserRole.SUPER_ADMIN) {
    throw new functions.https.HttpsError('permission-denied', 'Only Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a user is a Super Admin (async with Firestore fallback)
 */
export async function validateSuperAdminAsync(
  context: functions.https.CallableContext
): Promise<string> {
  const uid = validateAuthenticated(context);

  const isAdmin = await isSuperAdminWithFallback(context, uid);
  if (!isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Only Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a user is at least a Team Admin
 */
export function validateTeamAdminOrHigher(context: functions.https.CallableContext): string {
  const uid = validateAuthenticated(context);

  const role = context.auth?.token?.role;
  if (role !== UserRole.SUPER_ADMIN && role !== UserRole.TEAM_ADMIN) {
    throw new functions.https.HttpsError('permission-denied', 'Only Team Admin or Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a string is not empty
 */
export function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validates that a value is a valid role
 */
export function validateRole(role: unknown): UserRoleType {
  const validRoles = Object.values(UserRole);
  if (!validRoles.includes(role as UserRoleType)) {
    throw new functions.https.HttpsError('invalid-argument', `Invalid role. Must be one of: ${validRoles.join(', ')}`);
  }
  return role as UserRoleType;
}

/**
 * Validates that an array is not empty
 */
export function validateNonEmptyArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a non-empty array`);
  }
  return value as T[];
}

/**
 * Validates that a date string is valid and in the future
 */
export function validateFutureDate(dateString: unknown, fieldName: string): Date {
  if (typeof dateString !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  if (date <= new Date()) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be in the future`);
  }

  return date;
}

/**
 * Validates that a date string is valid (can be past or future)
 */
export function validateDate(dateString: unknown, fieldName: string): Date {
  if (typeof dateString !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  return date;
}

/**
 * Validates optional string with max length
 */
export function validateOptionalString(value: unknown, fieldName: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be a string`);
  }

  if (value.length > maxLength) {
    throw new functions.https.HttpsError('invalid-argument', `${fieldName} must be at most ${maxLength} characters`);
  }

  return value.trim() || undefined;
}
