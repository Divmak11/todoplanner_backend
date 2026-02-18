import { firestore } from 'firebase-admin';
import {
  UserRoleType,
  UserStatusType,
  TaskStatusType,
  TaskAssignmentStatusType,
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

// Task Types (supports both old single-assignee and new multi-assignee structure)
export interface Task {
  id: string;
  title: string;
  subtitle: string;
  assignedType: AssignmentTypeType;
  createdBy: string;
  status: TaskStatusType;
  deadline: firestore.Timestamp;
  createdAt: firestore.Timestamp;
  updatedAt: firestore.Timestamp;

  // Legacy single-assignee fields (for backward compatibility)
  assignedTo?: string;
  calendarEventId?: string;
  completedAt?: firestore.Timestamp;
  completionRemark?: string;

  // New multi-assignee fields
  isMultiAssignee?: boolean;
  assigneeIds?: string[];
  supervisorIds?: string[];
  taskGroupId?: string;
  sourceTeamId?: string;

  // Attachment URLs (max 3 images)
  attachmentUrls?: string[];
}

// Task Assignment (subcollection under tasks for multi-assignee tasks)
export interface TaskAssignment {
  id: string;
  userId: string;
  status: TaskAssignmentStatusType;
  assignedAt: firestore.Timestamp;
  completedAt?: firestore.Timestamp;
  completionRemark?: string;
  calendarEventId?: string;
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
  assignedTo: string | string[]; // Single ID or array for multiple assignees
  deadline: string; // ISO string
  supervisorIds?: string[]; // Users who can see all assignees' completion status
  attachmentUrls?: string[]; // Optional image attachment URLs (max 3)
}

export interface UpdateTaskInput {
  taskId: string;
  updates: {
    title?: string;
    subtitle?: string;
    deadline?: string; // ISO string
    attachmentUrls?: string[]; // Optional image attachment URLs (max 3)
  };
}

export interface CompleteTaskInput {
  taskId: string;
  remark?: string;
}

// Complete assignment for multi-assignee tasks
export interface CompleteAssignmentInput {
  taskId: string;
  remark?: string;
}

export interface CancelTaskInput {
  taskId: string;
}

export interface DeleteTaskInput {
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

// Report Exempt User Types
export interface UpdateReportExemptListInput {
  userIds: string[];
}
