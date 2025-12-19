/**
 * Validators for Firebase Cloud Functions (2nd Gen compatible)
 * 
 * These validators work with both 1st Gen and 2nd Gen Cloud Functions.
 * For 2nd Gen onCall, pass { auth: request.auth } as the context parameter.
 */

import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../config/firebase-admin';
import { UserRole, UserRoleType, Collections } from '../config/constants';

/**
 * Context interface compatible with both 1st Gen and 2nd Gen
 */
interface AuthContext {
  auth?: {
    uid: string;
    token?: {
      role?: string;
      [key: string]: unknown;
    };
  };
}

/**
 * Validates that a user is authenticated
 */
export function validateAuthenticated(context: AuthContext): string {
  if (!context.auth) {
    throw new HttpsError('unauthenticated', 'User must be logged in');
  }
  return context.auth.uid;
}

/**
 * Check if user is super admin using custom claims with Firestore fallback
 */
export async function isSuperAdminWithFallback(
  context: AuthContext,
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
export function validateSuperAdmin(context: AuthContext): string {
  const uid = validateAuthenticated(context);

  // Check custom claims for role
  const role = context.auth?.token?.role;
  if (role !== UserRole.SUPER_ADMIN) {
    throw new HttpsError('permission-denied', 'Only Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a user is a Super Admin (async with Firestore fallback)
 */
export async function validateSuperAdminAsync(
  context: AuthContext
): Promise<string> {
  const uid = validateAuthenticated(context);

  const isAdmin = await isSuperAdminWithFallback(context, uid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', 'Only Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a user is at least a Team Admin
 */
export function validateTeamAdminOrHigher(context: AuthContext): string {
  const uid = validateAuthenticated(context);

  const role = context.auth?.token?.role;
  if (role !== UserRole.SUPER_ADMIN && role !== UserRole.TEAM_ADMIN) {
    throw new HttpsError('permission-denied', 'Only Team Admin or Super Admin can perform this action');
  }

  return uid;
}

/**
 * Validates that a string is not empty
 */
export function validateRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpsError('invalid-argument', `${fieldName} is required and must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validates that a value is a valid role
 */
export function validateRole(role: unknown): UserRoleType {
  const validRoles = Object.values(UserRole);
  if (!validRoles.includes(role as UserRoleType)) {
    throw new HttpsError('invalid-argument', `Invalid role. Must be one of: ${validRoles.join(', ')}`);
  }
  return role as UserRoleType;
}

/**
 * Validates that an array is not empty
 */
export function validateNonEmptyArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a non-empty array`);
  }
  return value as T[];
}

/**
 * Validates that a date string is valid and in the future
 */
export function validateFutureDate(dateString: unknown, fieldName: string): Date {
  if (typeof dateString !== 'string') {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  if (date <= new Date()) {
    throw new HttpsError('invalid-argument', `${fieldName} must be in the future`);
  }

  return date;
}

/**
 * Validates that a date string is valid (can be past or future)
 */
export function validateDate(dateString: unknown, fieldName: string): Date {
  if (typeof dateString !== 'string') {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new HttpsError('invalid-argument', `${fieldName} must be a valid date string`);
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
    throw new HttpsError('invalid-argument', `${fieldName} must be a string`);
  }

  if (value.length > maxLength) {
    throw new HttpsError('invalid-argument', `${fieldName} must be at most ${maxLength} characters`);
  }

  return value.trim() || undefined;
}
