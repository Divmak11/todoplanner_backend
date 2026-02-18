import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import PDFDocument from 'pdfkit';
import { admin, db } from '../config/firebase-admin';
import { UserRole, Collections, ConfigDocs } from '../config/constants';
import { validateTeamAdminOrHigherAsync } from '../utils/validators';

interface ExportReportInput {
    startDate: string; // ISO date string
    endDate: string; // ISO date string
    teamId?: string;
    status?: string;
    userId?: string; // Single member filter (legacy)
    memberIds?: string[]; // All active member IDs for per-user grouping
}

// 2nd Gen configuration for report function - increased memory for PDF generation
const reportConfig = {
    region: 'asia-south1',
    memory: '512MiB' as const,
    timeoutSeconds: 120
};

/**
 * Export tasks report as PDF
 * Super Admin: can export for all teams/members
 * Team Admin: can export only for their teams' members
 * 
 * Report structure:
 * 1. Executive Summary: overall task counts, per-status breakdown, user metrics
 * 2. Per-User Sections: individual metrics + task list, ordered by task count (most → least)
 * 3. Zero-task users are included at the bottom with an empty state message
 */
export const exportReport = onCall(
    reportConfig,
    async (request: CallableRequest<ExportReportInput>) => {
        const data = request.data;
        const context = { auth: request.auth };

        // Validate caller is at least a Team Admin
        const { uid: callerUid, role: callerRole } = await validateTeamAdminOrHigherAsync(context);
        const isSuperAdmin = callerRole === UserRole.SUPER_ADMIN;

        const startDate = data.startDate ? new Date(data.startDate) : null;
        const endDate = data.endDate ? new Date(data.endDate) : null;
        let teamId = data.teamId || 'all';
        const status = data.status || 'all';
        const userId = data.userId || 'all'; // Single member filter
        const memberIds = data.memberIds || []; // All active member IDs from frontend

        // Team Admin scoping: restrict to their own teams
        if (!isSuperAdmin) {
            // Get teams where this user is the admin
            const teamsSnapshot = await db.collection(Collections.TEAMS)
                .where('adminId', '==', callerUid)
                .get();
            const adminTeamIds = teamsSnapshot.docs.map(d => d.id);

            if (adminTeamIds.length === 0) {
                throw new HttpsError('permission-denied', 'You are not an admin of any team');
            }

            // If Team Admin selected a specific team, verify they admin it
            if (teamId !== 'all') {
                if (!adminTeamIds.includes(teamId)) {
                    throw new HttpsError('permission-denied', 'You can only generate reports for your own teams');
                }
            } else {
                // If 'all' selected by Team Admin, scope to their first team
                // (Team Admins typically admin one team)
                teamId = adminTeamIds[0];
            }

            // If a specific member is selected, ensure they belong to one of the admin's teams
            if (userId !== 'all') {
                let memberBelongsToAdminTeam = false;
                for (const tid of adminTeamIds) {
                    const tDoc = await db.collection(Collections.TEAMS).doc(tid).get();
                    if (tDoc.exists && (tDoc.data()!.memberIds || []).includes(userId)) {
                        memberBelongsToAdminTeam = true;
                        break;
                    }
                }
                if (!memberBelongsToAdminTeam) {
                    throw new HttpsError('permission-denied', 'The selected member is not in your team');
                }
            }
        }

        try {
            // Build Firestore query
            let query: admin.firestore.Query = db.collection(Collections.TASKS);

            // Filter by deadline date range
            if (startDate && endDate) {
                const startTimestamp = admin.firestore.Timestamp.fromDate(startDate);
                const endTimestamp = admin.firestore.Timestamp.fromDate(endDate);
                query = query
                    .where('deadline', '>=', startTimestamp)
                    .where('deadline', '<=', endTimestamp)
                    .orderBy('deadline', 'desc');
            } else {
                query = query.orderBy('createdAt', 'desc').limit(100);
            }

            // Execute query
            const tasksSnapshot = await query.get();
            let tasks = tasksSnapshot.docs.map((doc) => ({
                id: doc.id,
                ...doc.data(),
            }));

            // =========== EXEMPT USER FILTERING ===========
            // For non-Super Admin callers, filter out tasks assigned to exempt users.
            // Single Firestore read per report — acceptable for infrequent operation.
            // No caching (TTL=0) because each report must reflect the latest list.
            if (!isSuperAdmin) {
                const exemptDoc = await db
                    .collection(Collections.CONFIG)
                    .doc(ConfigDocs.REPORT_EXEMPT_USERS)
                    .get();

                if (exemptDoc.exists) {
                    const exemptUserIds: string[] = exemptDoc.data()?.userIds || [];
                    if (exemptUserIds.length > 0) {
                        const exemptSet = new Set(exemptUserIds);
                        tasks = tasks.filter((task: any) => {
                            // Exclude if legacy assignedTo is exempt
                            if (task.assignedTo && exemptSet.has(task.assignedTo)) return false;
                            // Exclude if ALL assigneeIds are exempt (partial overlap = keep)
                            if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                                const nonExempt = task.assigneeIds.filter(
                                    (id: string) => !exemptSet.has(id)
                                );
                                if (nonExempt.length === 0) return false;
                            }
                            return true;
                        });
                    }
                }
            }

            // Filter by team (only if no specific member is selected)
            // When a member is selected, team filter is ignored
            if (teamId !== 'all' && userId === 'all') {
                const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
                if (teamDoc.exists) {
                    const teamMemberIds = teamDoc.data()!.memberIds || [];
                    tasks = tasks.filter((task: any) => {
                        // Check legacy assignedTo
                        if (teamMemberIds.includes(task.assignedTo)) return true;
                        // Check multi-assignee assigneeIds
                        if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                            return task.assigneeIds.some((id: string) => teamMemberIds.includes(id));
                        }
                        return false;
                    });
                }
            }

            // Filter by status
            if (status !== 'all') {
                tasks = tasks.filter((task: any) => task.status === status);
            }

            // Filter by member (individual user) - only show tasks where they are ASSIGNEE (not creator)
            if (userId !== 'all') {
                tasks = tasks.filter((task: any) => {
                    if (task.assignedTo === userId) return true;
                    if (task.assigneeIds && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(userId)) return true;
                    return false;
                });
            }

            // =========== BUILD USER DATA ===========
            // Fetch all member names (from memberIds or from tasks)
            const allUserIds = new Set<string>(memberIds);
            tasks.forEach((task: any) => {
                if (task.assignedTo) allUserIds.add(task.assignedTo);
                if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                    task.assigneeIds.forEach((id: string) => allUserIds.add(id));
                }
            });

            const userIdsList = Array.from(allUserIds).filter(id => id);
            const usersMap: Record<string, string> = {};

            // Batch fetch users (max 10 per batch for Firestore getAll)
            const batchSize = 10;
            for (let i = 0; i < userIdsList.length; i += batchSize) {
                const batch = userIdsList.slice(i, i + batchSize);
                const refs = batch.map(uid => db.collection(Collections.USERS).doc(uid));
                const docs = await db.getAll(...refs);
                docs.forEach(doc => {
                    if (doc.exists) {
                        usersMap[doc.id] = doc.data()!.name || 'Unknown';
                    }
                });
            }

            // Fetch team name if team filter was applied
            let teamName = '';
            if (teamId !== 'all') {
                try {
                    const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
                    if (teamDoc.exists) {
                        teamName = teamDoc.data()!.name || 'Unknown Team';
                    }
                } catch (e) {
                    teamName = 'Unknown Team';
                }
            }

            // =========== RESCHEDULE METRICS ===========
            const taskIds = tasks.map((t: any) => t.id);
            const rescheduleMap: Record<string, number> = {}; // taskId -> count
            const userRescheduleMap: Record<string, number> = {}; // userId -> count
            // Store previous deadlines per task for display
            const taskRescheduleHistory: Record<string, { previousDeadline: Date; newDeadline: Date; requestedBy: string }[]> = {};

            if (taskIds.length > 0) {
                const reschBatchSize = 30;
                for (let i = 0; i < taskIds.length; i += reschBatchSize) {
                    const batchIds = taskIds.slice(i, i + reschBatchSize);
                    const rescheduleQuery: admin.firestore.Query = db.collection(Collections.RESCHEDULE_LOG)
                        .where('taskId', 'in', batchIds);

                    const rescheduleSnapshot = await rescheduleQuery.get();
                    rescheduleSnapshot.docs.forEach((doc) => {
                        const log = doc.data();
                        const logDate = log.createdAt?.toDate ? log.createdAt.toDate() : null;

                        // Client-side date filtering
                        if (startDate && endDate && logDate) {
                            if (logDate < startDate || logDate > endDate) return;
                        }

                        const tId = log.taskId as string;
                        const rBy = log.requestedBy as string;

                        rescheduleMap[tId] = (rescheduleMap[tId] || 0) + 1;
                        if (rBy) {
                            userRescheduleMap[rBy] = (userRescheduleMap[rBy] || 0) + 1;
                        }

                        // Store reschedule history for display
                        if (!taskRescheduleHistory[tId]) taskRescheduleHistory[tId] = [];
                        taskRescheduleHistory[tId].push({
                            previousDeadline: log.previousDeadline?.toDate ? log.previousDeadline.toDate() : new Date(),
                            newDeadline: log.newDeadline?.toDate ? log.newDeadline.toDate() : new Date(),
                            requestedBy: rBy,
                        });
                    });
                }
            }

            const totalReschedules = Object.values(rescheduleMap).reduce((sum, c) => sum + c, 0);
            const tasksRescheduled = Object.keys(rescheduleMap).length;

            // =========== BUILD PER-USER TASK GROUPS ===========
            // Determine which users to include in the report
            const reportUserIds = memberIds.length > 0
                ? memberIds
                : Array.from(allUserIds).filter(id => id);

            // Group tasks by assignee
            const userTasksMap: Record<string, any[]> = {};
            for (const uid of reportUserIds) {
                userTasksMap[uid] = [];
            }

            tasks.forEach((task: any) => {
                // Assign task to the primary assignee (legacy)
                if (task.assignedTo && userTasksMap[task.assignedTo] !== undefined) {
                    userTasksMap[task.assignedTo].push(task);
                }
                // Also assign to multi-assignees (avoid duplicates for legacy assignedTo)
                if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                    task.assigneeIds.forEach((id: string) => {
                        if (id !== task.assignedTo && userTasksMap[id] !== undefined) {
                            userTasksMap[id].push(task);
                        }
                    });
                }
            });

            // Sort users by task count (most tasks first), zero-task users at the end
            const sortedUserIds = reportUserIds.sort((a, b) => {
                const aCount = userTasksMap[a]?.length || 0;
                const bCount = userTasksMap[b]?.length || 0;
                return bCount - aCount; // Descending — most tasks first
            });

            // Sort tasks within each user by status priority
            const statusOrder: Record<string, number> = { 'ongoing': 0, 'completed': 1, 'cancelled': 2 };
            for (const uid of sortedUserIds) {
                if (userTasksMap[uid]) {
                    userTasksMap[uid].sort((a: any, b: any) => {
                        const orderA = statusOrder[a.status] ?? 3;
                        const orderB = statusOrder[b.status] ?? 3;
                        if (orderA !== orderB) return orderA - orderB;
                        const deadlineA = a.deadline?.toDate?.() ?? new Date(0);
                        const deadlineB = b.deadline?.toDate?.() ?? new Date(0);
                        return deadlineB.getTime() - deadlineA.getTime();
                    });
                }
            }

            // Generate PDF
            const pdfBuffer = await generateTasksPDF(
                sortedUserIds,
                userTasksMap,
                usersMap,
                {
                    startDate,
                    endDate,
                    teamId,
                    teamName,
                    status,
                    userId,
                },
                {
                    rescheduleMap,
                    userRescheduleMap,
                    totalReschedules,
                    tasksRescheduled,
                    taskRescheduleHistory,
                },
                tasks.length
            );

            // Return PDF as base64
            return {
                success: true,
                pdfBase64: pdfBuffer.toString('base64'),
                taskCount: tasks.length,
            };
        } catch (error) {
            console.error('Error generating report:', error);
            throw new HttpsError(
                'internal',
                `Failed to generate report: ${error}`
            );
        }
    }
);

/**
 * Generate PDF document with per-user grouped tasks and executive summary.
 *
 * Layout:
 * - Header with branding
 * - Filter info
 * - Executive Summary (overall stats)
 * - Per-User Sections: user header → individual metrics → task cards
 * - Footer with page numbers
 */
async function generateTasksPDF(
    sortedUserIds: string[],
    userTasksMap: Record<string, any[]>,
    usersMap: Record<string, string>,
    filters: any,
    rescheduleData: {
        rescheduleMap: Record<string, number>;
        userRescheduleMap: Record<string, number>;
        totalReschedules: number;
        tasksRescheduled: number;
        taskRescheduleHistory: Record<string, { previousDeadline: Date; newDeadline: Date; requestedBy: string }[]>;
    },
    totalTaskCount: number
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ===== PROFESSIONAL COLOR PALETTE =====
        // Primary — deep navy + slate
        const navy = '#1a2332';
        const slateBlue = '#334155';
        const slate500 = '#64748b';
        const slate400 = '#94a3b8';
        const slate200 = '#e2e8f0';
        const slate100 = '#f1f5f9';
        const slate50 = '#f8fafc';

        // Semantic — muted, professional tones
        const successGreen = '#15803d';
        const successBg = '#f0fdf4';
        const warningAmber = '#b45309';
        const warningBg = '#fffbeb';
        const dangerRed = '#b91c1c';
        const dangerBg = '#fef2f2';
        const infoBlue = '#1d4ed8';
        const accentTeal = '#0f766e';

        const white = '#ffffff';

        const pageWidth = 595;
        const contentWidth = pageWidth - 80; // 40px margin each side
        const ml = 40; // margin left
        const now = new Date();

        // Helper: ensure enough vertical space
        const ensureSpace = (needed: number, currentY: number): number => {
            if (currentY > 780 - needed) {
                doc.addPage();
                return 50;
            }
            return currentY;
        };

        // =========== HEADER ===========
        doc.rect(0, 0, pageWidth, 80).fill(navy);

        // Subtle bottom accent line
        doc.rect(0, 80, pageWidth, 2).fill(slateBlue);

        doc.fontSize(20).font('Helvetica-Bold').fillColor(white)
            .text('TODO: Manager', ml, 22);
        doc.fontSize(9).font('Helvetica').fillColor(slate400)
            .text('Task Management Report', ml, 46);

        doc.fontSize(8).fillColor(slate400).text(
            now.toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric',
                year: 'numeric', hour: '2-digit', minute: '2-digit'
            }),
            pageWidth - 180, 30, { width: 140, align: 'right' }
        );

        let y = 100;

        // =========== REPORT FILTERS INFO ===========
        if (filters.startDate || (filters.status && filters.status !== 'all') || (filters.teamId && filters.teamId !== 'all')) {
            doc.rect(ml, y, contentWidth, 1).fill(slate200);
            y += 10;

            doc.fontSize(9).font('Helvetica').fillColor(slate500);
            const filterParts: string[] = [];

            if (filters.startDate && filters.endDate) {
                const sStr = filters.startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const eStr = filters.endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                filterParts.push(`Period: ${sStr} - ${eStr}`);
            }
            if (filters.status && filters.status !== 'all') {
                filterParts.push(`Status: ${filters.status.charAt(0).toUpperCase() + filters.status.slice(1)}`);
            }
            if (filters.teamId && filters.teamId !== 'all') {
                filterParts.push(`Team: ${filters.teamName || 'Selected'}`);
            }

            doc.text(filterParts.join('   |   '), ml, y, { width: contentWidth });
            y += 20;
        }

        y += 8;

        // =========== EXECUTIVE SUMMARY ===========
        doc.fontSize(13).font('Helvetica-Bold').fillColor(navy).text('Executive Summary', ml, y);
        y += 22;

        // Calculate overall stats
        const allTasks: any[] = [];
        Object.values(userTasksMap).forEach(tasks => {
            tasks.forEach(task => {
                if (!allTasks.find(t => t.id === task.id)) allTasks.push(task);
            });
        });

        const completedCount = allTasks.filter(t => t.status === 'completed').length;
        const ongoingCount = allTasks.filter(t => t.status === 'ongoing').length;
        const cancelledCount = allTasks.filter(t => t.status === 'cancelled').length;
        const overdueCount = allTasks.filter(t => {
            if (t.status !== 'ongoing') return false;
            const deadl = t.deadline?.toDate ? t.deadline.toDate() : null;
            return deadl && deadl < now;
        }).length;
        const activeNonOverdue = ongoingCount - overdueCount;
        const completionRate = totalTaskCount > 0 ? ((completedCount / totalTaskCount) * 100).toFixed(0) : '0';
        const usersWithZeroTasks = sortedUserIds.filter(uid => (userTasksMap[uid]?.length || 0) === 0).length;

        // ---- Stat cards: clean border-based design ----
        const cardW = (contentWidth - 16) / 3; // gap = 8 between
        const cardH = 52;

        const drawStatCard = (x: number, yp: number, label: string, value: string, accent: string, hasAlert: boolean = false) => {
            // White card with left accent border
            doc.rect(x, yp, cardW, cardH).fill(white);
            doc.rect(x, yp, cardW, cardH).lineWidth(0.5).stroke(slate200);
            doc.rect(x, yp, 3, cardH).fill(accent);

            doc.fontSize(20).font('Helvetica-Bold').fillColor(hasAlert ? accent : slateBlue)
                .text(value, x + 12, yp + 10, { width: cardW - 20 });
            doc.fontSize(7.5).font('Helvetica').fillColor(slate500)
                .text(label, x + 12, yp + 35, { width: cardW - 20 });
        };

        // Row 1
        drawStatCard(ml, y, 'Total Tasks', String(totalTaskCount), infoBlue);
        drawStatCard(ml + cardW + 8, y, `Completed (${completionRate}%)`, String(completedCount), successGreen);
        drawStatCard(ml + (cardW + 8) * 2, y, 'Active', String(activeNonOverdue), warningAmber);
        y += cardH + 6;

        // Row 2
        drawStatCard(ml, y, 'Overdue', String(overdueCount), dangerRed, overdueCount > 0);
        drawStatCard(ml + cardW + 8, y, 'Cancelled', String(cancelledCount), dangerRed, cancelledCount > 0);
        drawStatCard(ml + (cardW + 8) * 2, y, 'Rescheduled', String(rescheduleData.tasksRescheduled), warningAmber, rescheduleData.tasksRescheduled > 0);
        y += cardH + 6;

        // Row 3: half-width cards
        const halfW = (contentWidth - 8) / 2;
        // Members card
        drawStatCard(ml, y, 'Total Members', String(sortedUserIds.length), accentTeal);
        // Zero tasks card
        drawStatCard(ml + halfW + 8, y, 'Members with No Tasks', String(usersWithZeroTasks), usersWithZeroTasks > 0 ? warningAmber : slate400, usersWithZeroTasks > 0);

        y += cardH + 20;

        // =========== PER-USER SECTIONS ===========
        y = ensureSpace(200, y);
        if (y <= 50) {
            // We just added a page, so set up
        }

        doc.rect(ml, y, contentWidth, 1).fill(slate200);
        y += 12;

        doc.fontSize(13).font('Helvetica-Bold').fillColor(navy).text('Individual Member Reports', ml, y);
        y += 28;

        for (let userIndex = 0; userIndex < sortedUserIds.length; userIndex++) {
            const uid = sortedUserIds[userIndex];
            const userName = usersMap[uid] || 'Unknown User';
            const userTasks = userTasksMap[uid] || [];

            y = ensureSpace(140, y);

            // ---- User Header: clean navy bar ----
            const userTaskCount = userTasks.length;
            const userCompleted = userTasks.filter((t: any) => t.status === 'completed').length;
            const userOverdue = userTasks.filter((t: any) => {
                if (t.status !== 'ongoing') return false;
                const dl = t.deadline?.toDate ? t.deadline.toDate() : null;
                return dl && dl < now;
            }).length;
            const userReschedules = rescheduleData.userRescheduleMap[uid] || 0;

            // Header bar
            doc.rect(ml, y, contentWidth, 28).fill(navy);
            doc.fontSize(11).font('Helvetica-Bold').fillColor(white)
                .text(`${userIndex + 1}. ${userName}`, ml + 10, y + 8, { width: contentWidth - 90 });

            // Task count badge (white bg, black text)
            const cLabel = `${userTaskCount} task${userTaskCount !== 1 ? 's' : ''}`;
            const cW = doc.widthOfString(cLabel) + 12;
            doc.roundedRect(ml + contentWidth - cW - 8, y + 5, cW, 18, 3).fill(white);
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#111111')
                .text(cLabel, ml + contentWidth - cW - 8, y + 9, { width: cW, align: 'center' });
            y += 28;

            if (userTaskCount === 0) {
                doc.rect(ml, y, contentWidth, 32).fill(slate50);
                doc.rect(ml, y, contentWidth, 32).lineWidth(0.5).stroke(slate200);
                doc.fontSize(9).font('Helvetica').fillColor(slate500)
                    .text('No tasks assigned during this period.', ml + 10, y + 10, { width: contentWidth - 20 });
                y += 44;
                continue;
            }

            // ---- User Micro Metrics ----
            const mW = (contentWidth - 24) / 4;
            const mH = 30;
            const userCompRate = userTaskCount > 0 ? ((userCompleted / userTaskCount) * 100).toFixed(0) : '0';

            const drawMicro = (x: number, label: string, value: string, accent: string, alert: boolean = false) => {
                doc.rect(x, y, mW, mH).fill(slate50);
                doc.rect(x, y, 2, mH).fill(accent);
                doc.fontSize(12).font('Helvetica-Bold').fillColor(alert ? accent : slateBlue)
                    .text(value, x + 8, y + 4, { width: mW - 14 });
                doc.fontSize(6.5).font('Helvetica').fillColor(slate500)
                    .text(label, x + 8, y + 20, { width: mW - 14 });
            };

            drawMicro(ml, 'Total', String(userTaskCount), infoBlue);
            drawMicro(ml + mW + 8, `Done (${userCompRate}%)`, String(userCompleted), successGreen);
            drawMicro(ml + (mW + 8) * 2, 'Overdue', String(userOverdue), dangerRed, userOverdue > 0);
            drawMicro(ml + (mW + 8) * 3, 'Rescheduled', String(userReschedules), warningAmber, userReschedules > 0);
            y += mH + 8;

            // ---- Task Cards ----
            for (const task of userTasks) {
                y = ensureSpace(90, y);

                const title = task.title || 'Untitled Task';
                const subtitle = task.subtitle || '';
                const taskStatus = task.status || 'unknown';
                const deadline = task.deadline?.toDate ? task.deadline.toDate() : null;
                const createdAt = task.createdAt?.toDate ? task.createdAt.toDate() : null;
                const completedAt = task.completedAt?.toDate ? task.completedAt.toDate() : null;
                const taskRescheduleCount = rescheduleData.rescheduleMap[task.id] || 0;
                const isOverdue = taskStatus === 'ongoing' && deadline && deadline < now;

                // Status config
                let accentColor = slate400;
                let statusLabel = taskStatus.charAt(0).toUpperCase() + taskStatus.slice(1);
                let statusTextColor = slate500;
                let statusBgColor = slate100;

                if (taskStatus === 'completed') {
                    accentColor = successGreen;
                    statusTextColor = successGreen;
                    statusBgColor = successBg;
                } else if (taskStatus === 'ongoing') {
                    if (isOverdue) {
                        accentColor = dangerRed;
                        statusTextColor = dangerRed;
                        statusBgColor = dangerBg;
                        statusLabel = 'Overdue';
                    } else {
                        accentColor = warningAmber;
                        statusTextColor = warningAmber;
                        statusBgColor = warningBg;
                        statusLabel = 'In Progress';
                    }
                } else if (taskStatus === 'cancelled') {
                    accentColor = slate500;
                    statusTextColor = slate500;
                    statusBgColor = slate100;
                }

                // Card height
                const hasRescheduleHistory = taskRescheduleCount > 0 && rescheduleData.taskRescheduleHistory[task.id];
                const cardHeight = hasRescheduleHistory ? 84 : 70;

                // Card base
                doc.rect(ml, y, contentWidth, cardHeight).fill(white);
                doc.rect(ml, y, contentWidth, cardHeight).lineWidth(0.5).stroke(slate200);

                // Left accent
                doc.rect(ml, y, 3, cardHeight).fill(accentColor);

                // Title
                const cleanTitle = title.split('\n')[0].replace(/\s+/g, ' ').trim();
                doc.fontSize(10).font('Helvetica-Bold').fillColor(slateBlue).text(
                    cleanTitle,
                    ml + 12, y + 8, {
                    width: contentWidth - 110,
                    lineBreak: false, ellipsis: true, height: 12
                });

                // Status badge (pill)
                const bW = doc.widthOfString(statusLabel) + 12;
                doc.roundedRect(ml + contentWidth - bW - 8, y + 6, bW, 16, 8).fill(statusBgColor);
                doc.fontSize(7).font('Helvetica-Bold').fillColor(statusTextColor).text(
                    statusLabel,
                    ml + contentWidth - bW - 8, y + 9,
                    { width: bW, align: 'center' }
                );

                // Reschedule pill
                if (taskRescheduleCount > 0) {
                    const rLabel = `${taskRescheduleCount}x Rescheduled`;
                    const rW = doc.widthOfString(rLabel) + 10;
                    doc.roundedRect(ml + contentWidth - rW - 8, y + 24, rW, 12, 6).fill(warningBg);
                    doc.fontSize(6).font('Helvetica-Bold').fillColor(warningAmber).text(
                        rLabel,
                        ml + contentWidth - rW - 8, y + 27,
                        { width: rW, align: 'center' }
                    );
                }

                // Subtitle (single line)
                if (subtitle) {
                    const cleanSub = subtitle.split('\n')[0].replace(/\s+/g, ' ').trim();
                    doc.fontSize(7.5).font('Helvetica').fillColor(slate500).text(
                        cleanSub,
                        ml + 12, y + 24, {
                        width: contentWidth - 80,
                        lineBreak: false, ellipsis: true, height: 9
                    });
                }

                // Date info row
                let dateY = y + 40;
                doc.fontSize(7.5).fillColor(slate400);

                if (deadline) {
                    const dlStr = deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica').fillColor(slate500).text('Due: ', ml + 12, dateY, { continued: true });
                    doc.fillColor(isOverdue ? dangerRed : slateBlue).text(dlStr);
                }

                if (createdAt) {
                    const crStr = createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica').fillColor(slate500).text('Created: ', 240, dateY, { continued: true });
                    doc.fillColor(slate400).text(crStr);
                }

                dateY += 13;

                if (taskStatus === 'completed' && completedAt) {
                    const compStr = completedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica').fillColor(slate500).text('Done: ', ml + 12, dateY, { continued: true });
                    doc.fillColor(successGreen).text(compStr);
                }

                if (hasRescheduleHistory) {
                    const history = rescheduleData.taskRescheduleHistory[task.id];
                    const latest = history[history.length - 1];
                    if (latest?.previousDeadline) {
                        const prevStr = latest.previousDeadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                        doc.font('Helvetica').fillColor(slate500).text('Was due: ', 240, dateY, { continued: true });
                        doc.fillColor(warningAmber).text(prevStr);
                    }
                }

                y += cardHeight + 5;
            }

            // Spacing between users
            y += 10;
        }

        // =========== FOOTER (all pages) ===========
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);

            doc.moveTo(ml, 782).lineTo(pageWidth - ml, 782).lineWidth(0.5).stroke(slate200);

            doc.fontSize(7).font('Helvetica').fillColor(slate400).text(
                'TODO: Manager  |  Confidential Report',
                ml, 790
            );
            doc.text(
                `Page ${i + 1} of ${pageCount}`,
                pageWidth - 100, 790,
                { width: 60, align: 'right' }
            );
        }

        doc.end();
    });
}
