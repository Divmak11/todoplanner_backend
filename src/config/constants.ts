// User Roles
export const UserRole = {
  SUPER_ADMIN: 'super_admin',
  TEAM_ADMIN: 'team_admin',
  MEMBER: 'member',
} as const;

export type UserRoleType = typeof UserRole[keyof typeof UserRole];

// User Status
export const UserStatus = {
  PENDING: 'pending',
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;

export type UserStatusType = typeof UserStatus[keyof typeof UserStatus];

// Task Status
export const TaskStatus = {
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type TaskStatusType = typeof TaskStatus[keyof typeof TaskStatus];

// Task Assignment Status (for multi-assignee per-user tracking)
export const TaskAssignmentStatus = {
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
} as const;

export type TaskAssignmentStatusType = typeof TaskAssignmentStatus[keyof typeof TaskAssignmentStatus];

// Assignment Types
export const AssignmentType = {
  MEMBER: 'member',
  TEAM: 'team',
} as const;

export type AssignmentTypeType = typeof AssignmentType[keyof typeof AssignmentType];

// Approval Request Types
export const ApprovalRequestType = {
  RESCHEDULE: 'reschedule',
  USER_ACCESS: 'user_access',
} as const;

export type ApprovalRequestTypeType = typeof ApprovalRequestType[keyof typeof ApprovalRequestType];

// Approval Status
export const ApprovalStatus = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;

export type ApprovalStatusType = typeof ApprovalStatus[keyof typeof ApprovalStatus];

// Invite Status
export const InviteStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;

export type InviteStatusType = typeof InviteStatus[keyof typeof InviteStatus];

// Firestore Collections
export const Collections = {
  USERS: 'users',
  TEAMS: 'teams',
  TASKS: 'tasks',
  ASSIGNMENTS: 'assignments', // Subcollection under tasks for multi-assignee per-user tracking
  REMARKS: 'remarks',
  APPROVAL_REQUESTS: 'approvalRequests',
  RESCHEDULE_LOG: 'rescheduleLog',
  INVITES: 'invites',
  NOTIFICATIONS: 'notifications',
} as const;

// Notification Types
export const NotificationType = {
  NEW_PENDING_USER: 'new_pending_user',
  APPROVAL_GRANTED: 'approval_granted',
  APPROVAL_REJECTED: 'approval_rejected',
  TASK_ASSIGNED: 'task_assigned',
  TASK_UPDATED: 'task_updated',
  TASK_COMPLETED: 'task_completed',
  TASK_CANCELLED: 'task_cancelled',
  TASK_OVERDUE: 'task_overdue',
  RESCHEDULE_REQUESTED: 'reschedule_requested',
  RESCHEDULE_APPROVED: 'reschedule_approved',
  RESCHEDULE_REJECTED: 'reschedule_rejected',
  TEAM_CREATED: 'team_created',
  MEMBER_ADDED: 'member_added',
  MEMBER_REMOVED: 'member_removed',
  ROLE_CHANGED: 'role_changed',
  INVITE_SENT: 'invite_sent',
  INVITE_ACCEPTED: 'invite_accepted',
} as const;

export type NotificationTypeType = typeof NotificationType[keyof typeof NotificationType];
