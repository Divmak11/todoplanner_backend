# TODO Planner - Backend (Firebase Cloud Functions)

Backend services for the TODO Planner & Task Management App built with Firebase Cloud Functions (TypeScript).

## Tech Stack

- **Runtime**: Node.js 18
- **Language**: TypeScript
- **Framework**: Firebase Cloud Functions v4
- **Database**: Cloud Firestore
- **Authentication**: Firebase Auth
- **Notifications**: Firebase Cloud Messaging (FCM)
- **Calendar**: Google Calendar API

## Project Structure

```
todo-backend/
├── src/
│   ├── config/
│   │   ├── firebase-admin.ts    # Firebase Admin SDK initialization
│   │   └── constants.ts         # Constants, enums, collection names
│   ├── controllers/
│   │   ├── userController.ts    # User management functions
│   │   ├── teamController.ts    # Team management functions
│   │   ├── taskController.ts    # Task CRUD functions
│   │   └── rescheduleController.ts  # Reschedule workflow
│   ├── services/
│   │   ├── notificationService.ts   # FCM notification helpers
│   │   └── calendarService.ts       # Google Calendar integration
│   ├── triggers/
│   │   ├── authTriggers.ts          # Auth event triggers
│   │   ├── notificationTriggers.ts  # Firestore triggers for notifications
│   │   └── scheduledFunctions.ts    # Scheduled/cron functions
│   ├── types/
│   │   └── index.ts             # TypeScript interfaces
│   ├── utils/
│   │   └── validators.ts        # Input validation utilities
│   └── index.ts                 # Main entry point (exports all functions)
├── firestore.rules              # Firestore security rules
├── firestore.indexes.json       # Firestore composite indexes
├── firebase.json                # Firebase configuration
├── package.json
└── tsconfig.json
```

## Setup

### Prerequisites

1. Node.js 18+
2. Firebase CLI: `npm install -g firebase-tools`
3. Firebase project created in Firebase Console

### Installation

```bash
# Clone and navigate to project
cd todo-backend

# Install dependencies
npm install

# Login to Firebase
firebase login

# Set your Firebase project
firebase use --add
```

### Environment Configuration

Set required environment variables:

```bash
# Set Super Admin email (first user with this email gets super_admin role)
firebase functions:config:set app.super_admin_email="admin@yourcompany.com"

# Optional: SendGrid API key for email notifications
firebase functions:config:set sendgrid.key="YOUR_SENDGRID_API_KEY"
```

## Development

### Build

```bash
npm run build
```

### Run Emulators

```bash
npm run serve
# or
firebase emulators:start
```

### Lint

```bash
npm run lint
npm run lint:fix
```

## Deployment

### Deploy to Development

```bash
firebase use dev
npm run deploy
```

### Deploy to Production

```bash
firebase use prod
npm run deploy
```

### Deploy Specific Components

```bash
# Functions only
firebase deploy --only functions

# Firestore rules only
firebase deploy --only firestore:rules

# Firestore indexes only
firebase deploy --only firestore:indexes
```

## Cloud Functions Reference

### User Management

| Function | Type | Description |
|----------|------|-------------|
| `approveUserAccess` | Callable | Approve pending user (Super Admin only) |
| `rejectUserAccess` | Callable | Reject pending user (Super Admin only) |
| `updateUserRole` | Callable | Change user role (Super Admin only) |
| `revokeUserAccess` | Callable | Disable user account (Super Admin only) |
| `deleteUser` | Callable | Permanently delete user (Super Admin only) |

### Team Management

| Function | Type | Description |
|----------|------|-------------|
| `createTeam` | Callable | Create new team (Super Admin only) |
| `updateTeam` | Callable | Update team (Super Admin or Team Admin) |
| `deleteTeam` | Callable | Delete team (Super Admin only) |

### Task Management

| Function | Type | Description |
|----------|------|-------------|
| `assignTask` | Callable | Create and assign task |
| `updateTask` | Callable | Update task details |
| `completeTask` | Callable | Mark task as completed (Assignee only) |
| `cancelTask` | Callable | Cancel task (Creator or Super Admin) |
| `reopenTask` | Callable | Reopen completed task (Super Admin only) |

### Reschedule Workflow

| Function | Type | Description |
|----------|------|-------------|
| `requestReschedule` | Callable | Request deadline change (Assignee only) |
| `approveReschedule` | Callable | Approve/reject reschedule (Task creator) |

### Triggers

| Function | Type | Description |
|----------|------|-------------|
| `createUserProfile` | Auth onCreate | Create user profile on signup |
| `onUserDeleted` | Auth onDelete | Cleanup on user deletion |
| `notifyAdminNewUser` | Firestore onCreate | Notify admins of new users |
| `notifyUserStatusChange` | Firestore onUpdate | Notify user of status changes |
| `notifyTeamCreation` | Firestore onCreate | Notify members of new team |
| `notifyTeamMemberChange` | Firestore onUpdate | Notify on member add/remove |
| `notifyTaskAssignment` | Firestore onCreate | Notify assignee of new task |
| `notifyTaskStatusChange` | Firestore onUpdate | Notify on task completion/cancellation |

### Scheduled Functions

| Function | Schedule | Description |
|----------|----------|-------------|
| `checkDeadlines` | Every hour | Send deadline reminders |
| `checkOverdueTasks` | Daily 9 AM | Alert on overdue tasks |
| `cleanupInactiveTracking` | Daily midnight | Cleanup tasks |

## Frontend Integration

### Calling Functions from Flutter

```dart
import 'package:cloud_functions/cloud_functions.dart';

// Example: Approve user
Future<void> approveUser(String userId) async {
  final callable = FirebaseFunctions.instance.httpsCallable('approveUserAccess');
  final result = await callable.call({'userId': userId});
  print(result.data); // {success: true, message: 'User approved successfully'}
}

// Example: Create task
Future<void> createTask(Map<String, dynamic> taskData) async {
  final callable = FirebaseFunctions.instance.httpsCallable('assignTask');
  final result = await callable.call(taskData);
  print(result.data); // {success: true, taskId: 'abc123'}
}
```

## Monitoring

- **Firebase Console**: View function logs and metrics
- **Cloud Logging**: Detailed logs at console.cloud.google.com
- **FCM Metrics**: Track notification delivery

## License

Private - All rights reserved
