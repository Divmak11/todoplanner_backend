/**
 * TODO Planner & Task Management - Firebase Cloud Functions
 *
 * This is the main entry point for all Cloud Functions.
 * Functions are organized by module:
 * - User Management (approveUserAccess, rejectUserAccess, updateUserRole, etc.)
 * - Team Management (createTeam, updateTeam, deleteTeam)
 * - Task Management (assignTask, updateTask, completeTask, cancelTask, reopenTask)
 * - Reschedule Management (requestReschedule, approveReschedule)
 * - Auth Triggers (createUserProfile, onUserDeleted)
 * - Notification Triggers (various Firestore triggers)
 * - Scheduled Functions (checkDeadlines, checkOverdueTasks)
 */

// Initialize Firebase Admin
import './config/firebase-admin';

// ============================================
// USER MANAGEMENT FUNCTIONS
// ============================================
export {
  approveUserAccess,
  rejectUserAccess,
  updateUserRole,
  revokeUserAccess,
  restoreUserAccess,
  deleteUser,
  updateProfile,
} from './controllers/userController';

// ============================================
// TEAM MANAGEMENT FUNCTIONS
// ============================================
export {
  createTeam,
  updateTeam,
  deleteTeam,
} from './controllers/teamController';

// ============================================
// TASK MANAGEMENT FUNCTIONS
// ============================================
export {
  assignTask,
  updateTask,
  completeTask,
  cancelTask,
  reopenTask,
} from './controllers/taskController';

// ============================================
// RESCHEDULE MANAGEMENT FUNCTIONS
// ============================================
export {
  requestReschedule,
  approveReschedule,
} from './controllers/rescheduleController';

// ============================================
// REMARK MANAGEMENT FUNCTIONS
// ============================================
export { addRemark } from './controllers/remarkController';

// ============================================
// CALENDAR FUNCTIONS
// ============================================
export { disconnectCalendar } from './services/calendarService';

// ============================================
// INVITE MANAGEMENT FUNCTIONS
// ============================================
export {
  sendInvite,
  resendInvite,
  cancelInvite,
  validateInviteToken,
  acceptInvite,
  getInvites,
} from './controllers/inviteController';

// ============================================
// AUTH TRIGGERS
// ============================================
export {
  createUserProfile,
  onUserDeleted,
} from './triggers/authTriggers';

// ============================================
// NOTIFICATION TRIGGERS (Firestore)
// ============================================
export {
  notifyAdminNewUser,
  notifyUserStatusChange,
  notifyTeamCreation,
  notifyTeamMemberChange,
  notifyTaskAssignment,
  notifyTaskStatusChange,
} from './triggers/notificationTriggers';

// ============================================
// SCHEDULED FUNCTIONS
// ============================================
export {
  checkDeadlines,
  checkOverdueTasks,
  cleanupInactiveTracking,
} from './triggers/scheduledFunctions';

// ============================================
// REPORT EXPORT FUNCTIONS
// ============================================
export { exportReport } from './controllers/reportController';
