import { firestore } from 'firebase-admin';
import {
  UserRoleType,
  UserStatusType,
  TaskStatusType,
  AssignmentTypeType,
  ApprovalRequestTypeType,
  ApprovalStatusType,
  InviteStatusType,
} from '../config/constants';

// User Types
export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRoleType;
  teamIds: string[];
  status: UserStatusType;
  googleCalendarConnected: boolean;
  googleAccessToken?: string;
  googleRefreshToken?: string;
  fcmToken?: string;
  createdAt: firestore.Timestamp;
  lastActive: firestore.Timestamp;
  approvedBy?: string;
  approvedAt?: firestore.Timestamp;
  rejectedBy?: string;
  rejectedAt?: firestore.Timestamp;
  revokedBy?: string;
  revokedAt?: firestore.Timestamp;
  roleUpdatedBy?: string;
  roleUpdatedAt?: firestore.Timestamp;
}

// Team Types
export interface Team {
  id: string;
  name: string;
  adminId: string;
  memberIds: string[];
  createdBy: string;
  createdAt: firestore.Timestamp;
  updatedAt?: firestore.Timestamp;
  updatedBy?: string;
}

// Task Types
export interface Task {
  id: string;
  title: string;
  subtitle: string;
  assignedType: AssignmentTypeType;
  assignedTo: string;
  createdBy: string;
  status: TaskStatusType;
  deadline: firestore.Timestamp;
  calendarEventId?: string;
  createdAt: firestore.Timestamp;
  updatedAt: firestore.Timestamp;
  completedAt?: firestore.Timestamp;
  completionRemark?: string;
}

// Remark Types
export interface Remark {
  id: string;
  taskId: string;
  userId: string;
  message: string;
  createdAt: firestore.Timestamp;
}

// Approval Request Types
export interface ApprovalRequest {
  id: string;
  type: ApprovalRequestTypeType;
  requesterId: string;
  targetId: string;
  payload: {
    newDeadline?: firestore.Timestamp;
    originalDeadline?: firestore.Timestamp;
    reason?: string;
    email?: string;
  };
  status: ApprovalStatusType;
  approverId?: string;
  createdAt: firestore.Timestamp;
  resolvedAt?: firestore.Timestamp;
}

// Reschedule Log Types
export interface RescheduleLog {
  id: string;
  taskId: string;
  requestedBy: string;
  originalDeadline: firestore.Timestamp;
  newDeadline: firestore.Timestamp;
  approvedBy: string;
  createdAt: firestore.Timestamp;
}

// Function Input Types
export interface ApproveUserInput {
  userId: string;
}

export interface RejectUserInput {
  userId: string;
  reason?: string;
}

export interface UpdateUserRoleInput {
  userId: string;
  newRole: UserRoleType;
}

export interface RevokeUserInput {
  userId: string;
}

export interface DeleteUserInput {
  userId: string;
}

export interface CreateTeamInput {
  name: string;
  memberIds: string[];
  adminId: string;
}

export interface UpdateTeamInput {
  teamId: string;
  updates: {
    name?: string;
    memberIds?: string[];
    adminId?: string;
  };
}

export interface DeleteTeamInput {
  teamId: string;
}

export interface AssignTaskInput {
  title: string;
  subtitle: string;
  assignedType: AssignmentTypeType;
  assignedTo: string;
  deadline: string; // ISO string
}

export interface UpdateTaskInput {
  taskId: string;
  updates: {
    title?: string;
    subtitle?: string;
    deadline?: string; // ISO string
  };
}

export interface CompleteTaskInput {
  taskId: string;
  remark?: string;
}

export interface CancelTaskInput {
  taskId: string;
}

export interface ReopenTaskInput {
  taskId: string;
  newDeadline: string; // ISO string
}

export interface RequestRescheduleInput {
  taskId: string;
  newDeadline: string; // ISO string
  reason?: string;
}

export interface ApproveRescheduleInput {
  requestId: string;
  approved: boolean;
}

export interface AddRemarkInput {
  taskId: string;
  message: string;
}

// Invite Types
export interface Invite {
  id: string;
  email: string;
  invitedBy: string;
  teamId?: string;
  token: string;
  status: InviteStatusType;
  createdAt: firestore.Timestamp;
  expiresAt: firestore.Timestamp;
  acceptedAt?: firestore.Timestamp;
  acceptedBy?: string;
}

// Invite Function Input Types
export interface SendInviteInput {
  email: string;
  teamId?: string;
}

export interface ResendInviteInput {
  inviteId: string;
}

export interface CancelInviteInput {
  inviteId: string;
}
