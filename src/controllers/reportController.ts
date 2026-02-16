import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import PDFDocument from 'pdfkit';
import { admin, db } from '../config/firebase-admin';
import { UserRole, Collections } from '../config/constants';
import { validateTeamAdminOrHigherAsync } from '../utils/validators';

interface ExportReportInput {
    startDate: string; // ISO date string
    endDate: string; // ISO date string
    teamId?: string;
    status?: string;
    userId?: string; // Add member filter
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
        const userId = data.userId || 'all'; // Member filter

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

            // Filter by team (only if no specific member is selected)
            // When a member is selected, team filter is ignored
            if (teamId !== 'all' && userId === 'all') {
                const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
                if (teamDoc.exists) {
                    const memberIds = teamDoc.data()!.memberIds || [];
                    tasks = tasks.filter((task: any) => {
                        // Check legacy assignedTo
                        if (memberIds.includes(task.assignedTo)) return true;
                        // Check multi-assignee assigneeIds
                        if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                            return task.assigneeIds.some((id: string) => memberIds.includes(id));
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
            // This makes the member report show only tasks assigned to them
            if (userId !== 'all') {
                tasks = tasks.filter((task: any) => {
                    // Include tasks where user is assignedTo (legacy)
                    if (task.assignedTo === userId) return true;
                    // Include tasks where user is in assigneeIds (multi-assignee)
                    if (task.assigneeIds && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(userId)) return true;
                    // Note: NOT including tasks they created - those go to different view
                    return false;
                });
            }

            // Sort tasks by status: ongoing → completed → cancelled
            const statusOrder: Record<string, number> = { 'ongoing': 0, 'completed': 1, 'cancelled': 2 };
            tasks.sort((a: any, b: any) => {
                const orderA = statusOrder[a.status] ?? 3;
                const orderB = statusOrder[b.status] ?? 3;
                if (orderA !== orderB) return orderA - orderB;
                // Within same status, sort by deadline (most recent first)
                const deadlineA = a.deadline?.toDate?.() ?? new Date(0);
                const deadlineB = b.deadline?.toDate?.() ?? new Date(0);
                return deadlineB.getTime() - deadlineA.getTime();
            });

            // Fetch user data for assignee names
            const allUserIds = new Set<string>();
            tasks.forEach((task: any) => {
                if (task.assignedTo) allUserIds.add(task.assignedTo);
                if (task.assigneeIds && Array.isArray(task.assigneeIds)) {
                    task.assigneeIds.forEach((id: string) => allUserIds.add(id));
                }
            });

            const userIds = Array.from(allUserIds).filter(id => id); // Filter out empty/null
            const usersMap: Record<string, string> = {};

            for (const userId of userIds) {
                try {
                    const userDoc = await db.collection(Collections.USERS).doc(userId).get();
                    if (userDoc.exists) {
                        usersMap[userId] = userDoc.data()!.name || 'Unknown';
                    }
                } catch (e) {
                    console.warn(`Failed to fetch user ${userId}:`, e);
                }
            }

            // Also fetch the member name if a specific member filter was applied
            let memberName = '';
            if (userId !== 'all') {
                try {
                    const memberDoc = await db.collection(Collections.USERS).doc(userId).get();
                    if (memberDoc.exists) {
                        memberName = memberDoc.data()!.name || 'Unknown Member';
                    }
                } catch (e) {
                    memberName = 'Unknown Member';
                }
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
            // Query reschedule logs for the tasks in our result set
            const taskIds = tasks.map((t: any) => t.id);
            const rescheduleMap: Record<string, number> = {}; // taskId -> count
            const userRescheduleMap: Record<string, number> = {}; // userId -> count

            if (taskIds.length > 0) {
                // Firestore 'in' queries support max 30 values, so batch if needed
                const batchSize = 30;
                for (let i = 0; i < taskIds.length; i += batchSize) {
                    const batchIds = taskIds.slice(i, i + batchSize);
                    let rescheduleQuery: admin.firestore.Query = db.collection(Collections.RESCHEDULE_LOG)
                        .where('taskId', 'in', batchIds);

                    // Optionally filter by date range
                    if (startDate && endDate) {
                        // Note: can't combine 'in' with range on different field in Firestore
                        // So we do client-side date filtering
                    }

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
                    });
                }
            }

            const totalReschedules = Object.values(rescheduleMap).reduce((sum, c) => sum + c, 0);
            const tasksRescheduled = Object.keys(rescheduleMap).length;

            // Generate PDF
            const pdfBuffer = await generateTasksPDF(tasks, usersMap, {
                startDate,
                endDate,
                teamId,
                teamName,
                status,
                userId,
                memberName,
            }, {
                rescheduleMap,
                userRescheduleMap,
                totalReschedules,
                tasksRescheduled,
            });

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
 * Generate PDF document from tasks data with professional design
 */
async function generateTasksPDF(
    tasks: any[],
    usersMap: Record<string, string>,
    filters: any,
    rescheduleData: {
        rescheduleMap: Record<string, number>;
        userRescheduleMap: Record<string, number>;
        totalReschedules: number;
        tasksRescheduled: number;
    }
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
        const chunks: Buffer[] = [];

        // Collect PDF data
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Colors
        const primaryBlue = '#1e40af';
        const darkBlue = '#1e3a8a';
        const green = '#16a34a';
        const lightGreen = '#dcfce7';
        const yellow = '#ca8a04';
        const lightYellow = '#fef9c3';
        const red = '#dc2626';
        const lightRed = '#fee2e2';
        const gray = '#64748b';
        const darkGray = '#374151';
        const lightGray = '#f8fafc';
        const borderGray = '#e2e8f0';
        const orange = '#ea580c';
        const lightOrange = '#fff7ed';

        const pageWidth = 595;
        const contentWidth = pageWidth - 80; // 40px margin on each side

        // =========== HEADER ===========
        doc.rect(0, 0, pageWidth, 100).fill(primaryBlue);

        // Company/App name
        doc.fontSize(24).font('Helvetica-Bold').fillColor('white').text('TODO: Manager', 40, 30);
        doc.fontSize(11).font('Helvetica').fillColor('#93c5fd').text('Task Management Report', 40, 58);

        // Generation date on top right
        doc.fontSize(9).fillColor('#bfdbfe').text(
            `Generated: ${new Date().toLocaleDateString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })}`,
            pageWidth - 200, 40, { width: 160, align: 'right' }
        );

        let y = 120;

        // =========== REPORT FILTERS INFO ===========
        doc.fontSize(10).font('Helvetica').fillColor(darkGray);

        if (filters.startDate && filters.endDate) {
            const startStr = filters.startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            const endStr = filters.endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            doc.font('Helvetica-Bold').text('Period: ', 40, y, { continued: true });
            doc.font('Helvetica').text(`${startStr} — ${endStr}`);
            y += 18;
        }

        if (filters.status && filters.status !== 'all') {
            doc.font('Helvetica-Bold').text('Status Filter: ', 40, y, { continued: true });
            doc.font('Helvetica').text(filters.status.charAt(0).toUpperCase() + filters.status.slice(1));
            y += 18;
        }

        if (filters.teamId && filters.teamId !== 'all') {
            doc.font('Helvetica-Bold').text('Team: ', 40, y, { continued: true });
            doc.font('Helvetica').text(filters.teamName || 'Specific Team');
            y += 18;
        }

        // Show member name if filtered by member
        if (filters.userId && filters.userId !== 'all') {
            doc.font('Helvetica-Bold').text('Member: ', 40, y, { continued: true });
            doc.font('Helvetica').text(filters.memberName || 'Specific Member');
            y += 18;
        }

        y += 15;

        // =========== SUMMARY STATISTICS CARDS ===========
        const completedCount = tasks.filter((t) => t.status === 'completed').length;
        const ongoingCount = tasks.filter((t) => t.status === 'ongoing').length;
        const now = new Date();
        const overdueCount = tasks.filter((t) => {
            if (t.status !== 'ongoing') return false;
            const deadline = t.deadline?.toDate ? t.deadline.toDate() : null;
            return deadline && deadline < now;
        }).length;
        const completionRate = tasks.length > 0 ? ((completedCount / tasks.length) * 100).toFixed(0) : '0';

        // Card dimensions
        const cardWidth = (contentWidth - 30) / 4; // 4 cards with 10px gaps
        const cardHeight = 65;
        const cardY = y;

        // Helper to draw stat card
        const drawStatCard = (x: number, label: string, value: string, bgColor: string, textColor: string) => {
            // Card background with rounded corners simulation
            doc.rect(x, cardY, cardWidth, cardHeight).fill(bgColor);
            doc.rect(x, cardY, cardWidth, 4).fill(textColor); // Top accent bar

            doc.fontSize(22).font('Helvetica-Bold').fillColor(textColor).text(value, x + 10, cardY + 18, { width: cardWidth - 20 });
            doc.fontSize(9).font('Helvetica').fillColor(darkGray).text(label, x + 10, cardY + 45, { width: cardWidth - 20 });
        };

        drawStatCard(40, 'Total Tasks', String(tasks.length), lightGray, primaryBlue);
        drawStatCard(40 + cardWidth + 10, 'Completed', `${completedCount} (${completionRate}%)`, lightGreen, green);
        drawStatCard(40 + (cardWidth + 10) * 2, 'In Progress', String(ongoingCount), lightYellow, yellow);
        drawStatCard(40 + (cardWidth + 10) * 3, 'Overdue', String(overdueCount), overdueCount > 0 ? lightRed : lightGray, overdueCount > 0 ? red : gray);

        y = cardY + cardHeight + 25;

        // =========== RESCHEDULE INSIGHTS SECTION ===========
        if (rescheduleData.totalReschedules > 0) {
            // Section title
            doc.fontSize(14).font('Helvetica-Bold').fillColor(orange).text('Reschedule Insights', 40, y);
            y += 22;

            // Summary stats row
            const rescheduleRate = tasks.length > 0
                ? ((rescheduleData.tasksRescheduled / tasks.length) * 100).toFixed(0)
                : '0';

            const rCardWidth = (contentWidth - 20) / 3;
            const rCardHeight = 55;

            // Card 1: Total Reschedules
            doc.rect(40, y, rCardWidth, rCardHeight).fill(lightOrange);
            doc.rect(40, y, rCardWidth, 3).fill(orange);
            doc.fontSize(20).font('Helvetica-Bold').fillColor(orange)
                .text(String(rescheduleData.totalReschedules), 50, y + 14, { width: rCardWidth - 20 });
            doc.fontSize(8).font('Helvetica').fillColor(darkGray)
                .text('Total Reschedules', 50, y + 38, { width: rCardWidth - 20 });

            // Card 2: Tasks Rescheduled
            const rx2 = 40 + rCardWidth + 10;
            doc.rect(rx2, y, rCardWidth, rCardHeight).fill(lightOrange);
            doc.rect(rx2, y, rCardWidth, 3).fill(orange);
            doc.fontSize(20).font('Helvetica-Bold').fillColor(orange)
                .text(String(rescheduleData.tasksRescheduled), rx2 + 10, y + 14, { width: rCardWidth - 20 });
            doc.fontSize(8).font('Helvetica').fillColor(darkGray)
                .text('Tasks Rescheduled', rx2 + 10, y + 38, { width: rCardWidth - 20 });

            // Card 3: Reschedule Rate
            const rx3 = 40 + (rCardWidth + 10) * 2;
            doc.rect(rx3, y, rCardWidth, rCardHeight).fill(lightOrange);
            doc.rect(rx3, y, rCardWidth, 3).fill(orange);
            doc.fontSize(20).font('Helvetica-Bold').fillColor(orange)
                .text(`${rescheduleRate}%`, rx3 + 10, y + 14, { width: rCardWidth - 20 });
            doc.fontSize(8).font('Helvetica').fillColor(darkGray)
                .text('Reschedule Rate', rx3 + 10, y + 38, { width: rCardWidth - 20 });

            y += rCardHeight + 15;

            // Per-user reschedule table (only if team/all report, not single user)
            const usersWithReschedules = Object.entries(rescheduleData.userRescheduleMap);
            if (usersWithReschedules.length > 0 && (filters.userId === 'all' || !filters.userId)) {
                // Check page space
                if (y > 650) {
                    doc.addPage();
                    y = 50;
                }

                doc.fontSize(10).font('Helvetica-Bold').fillColor(darkGray)
                    .text('Per-User Reschedule Breakdown', 40, y);
                y += 18;

                // Table header
                doc.rect(40, y, contentWidth, 20).fill('#f1f5f9');
                doc.fontSize(8).font('Helvetica-Bold').fillColor(darkGray);
                doc.text('User', 50, y + 6, { width: 200 });
                doc.text('Reschedules', 260, y + 6, { width: 80, align: 'center' });
                doc.text('Tasks Affected', 350, y + 6, { width: 80, align: 'center' });
                y += 20;

                for (const [uid, count] of usersWithReschedules) {
                    if (y > 730) {
                        doc.addPage();
                        y = 50;
                    }

                    const userName = usersMap[uid] || 'Unknown';
                    doc.rect(40, y, contentWidth, 18).fill(y % 2 === 0 ? '#ffffff' : '#fafafa');
                    doc.fontSize(8).font('Helvetica').fillColor(darkGray);
                    doc.text(userName, 50, y + 5, { width: 200, lineBreak: false, ellipsis: true });
                    doc.text(String(count), 260, y + 5, { width: 80, align: 'center' });

                    // Count how many unique tasks this user rescheduled
                    // (We don't have per-user-per-task data in the aggregated map,
                    //  so we show the total reschedule count per user)
                    doc.text('-', 350, y + 5, { width: 80, align: 'center' });
                    y += 18;
                }

                y += 10;
            }

            y += 10;
        }

        // =========== TASKS SECTION TITLE ===========
        doc.fontSize(14).font('Helvetica-Bold').fillColor(darkBlue).text('Task Details', 40, y);
        y += 25;

        // =========== TASK CARDS ===========
        if (tasks.length === 0) {
            doc.fontSize(11).font('Helvetica').fillColor(gray).text('No tasks found for the selected filters.', 40, y);
        } else {
            for (const task of tasks) {
                // Check if we need a new page (need at least 100px for a card)
                if (y > 680) {
                    doc.addPage();
                    y = 50;
                }

                const title = task.title || 'Untitled Task';
                const subtitle = task.subtitle || '';
                const assignee = usersMap[task.assignedTo] || 'Unknown';
                const status = task.status || 'unknown';
                const deadline = task.deadline?.toDate ? task.deadline.toDate() : null;
                const createdAt = task.createdAt?.toDate ? task.createdAt.toDate() : null;
                const completedAt = task.completedAt?.toDate ? task.completedAt.toDate() : null;
                const taskRescheduleCount = rescheduleData.rescheduleMap[task.id] || 0;

                // Check if overdue
                const isOverdue = status === 'ongoing' && deadline && deadline < now;

                // Status styling
                let statusBg = lightGray;
                let statusText = gray;
                let statusLabel = status.charAt(0).toUpperCase() + status.slice(1);

                if (status === 'completed') {
                    statusBg = lightGreen;
                    statusText = green;
                } else if (status === 'ongoing') {
                    if (isOverdue) {
                        statusBg = lightRed;
                        statusText = red;
                        statusLabel = 'Overdue';
                    } else {
                        statusBg = lightYellow;
                        statusText = yellow;
                        statusLabel = 'In Progress';
                    }
                } else if (status === 'cancelled') {
                    statusBg = lightRed;
                    statusText = red;
                }

                // Card background - proper height with spacing for all content
                const taskCardHeight = 110;
                doc.rect(40, y, contentWidth, taskCardHeight).fill('#ffffff');
                doc.rect(40, y, contentWidth, taskCardHeight).stroke(borderGray);

                // Left accent bar based on status
                doc.rect(40, y, 4, taskCardHeight).fill(statusText);

                // Task Title - Stripping newlines and forcing single line
                const cleanTitle = title.split('\n')[0].replace(/\s+/g, ' ').trim();
                doc.fontSize(12).font('Helvetica-Bold').fillColor(darkGray).text(
                    cleanTitle,
                    52, y + 12, {
                    width: contentWidth - 130,
                    lineBreak: false,
                    ellipsis: true,
                    height: 14
                }
                );

                // Status badge (top right)
                const badgeWidth = doc.widthOfString(statusLabel) + 16;
                doc.rect(40 + contentWidth - badgeWidth - 10, y + 10, badgeWidth, 20).fill(statusBg);
                doc.fontSize(9).font('Helvetica-Bold').fillColor(statusText).text(
                    statusLabel,
                    40 + contentWidth - badgeWidth - 10, y + 15,
                    { width: badgeWidth, align: 'center' }
                );

                // Reschedule badge (below status badge)
                if (taskRescheduleCount > 0) {
                    const rescheduleLabel = `${taskRescheduleCount}x Rescheduled`;
                    const rBadgeWidth = doc.widthOfString(rescheduleLabel) + 16;
                    doc.rect(40 + contentWidth - rBadgeWidth - 10, y + 32, rBadgeWidth, 16).fill(lightOrange);
                    doc.fontSize(7).font('Helvetica-Bold').fillColor(orange).text(
                        rescheduleLabel,
                        40 + contentWidth - rBadgeWidth - 10, y + 35,
                        { width: rBadgeWidth, align: 'center' }
                    );
                }

                // Subtitle/Description - Aggressively cleaning and forcing single line
                let subtitleY = y + 36;
                if (subtitle) {
                    // TAKE ONLY THE FIRST LINE, collapse whitespace, and truncate
                    const firstLine = subtitle.split('\n')[0].trim();
                    const cleanSubtitle = firstLine.replace(/\s+/g, ' ');

                    doc.fontSize(9).font('Helvetica').fillColor(gray).text(
                        cleanSubtitle,
                        52, subtitleY, {
                        width: contentWidth - 70,
                        lineBreak: false,
                        ellipsis: true,
                        height: 11
                    }
                    );
                }

                // Bottom info rows - ensure safe offset from subtitle
                let infoY = y + 60;
                doc.fontSize(8).font('Helvetica').fillColor(gray);

                // Row 1: Assignee and Deadline
                doc.font('Helvetica-Bold').text('Assignee:', 52, infoY);
                const truncatedAssignee = assignee.length > 18 ? assignee.substring(0, 18) + '...' : assignee;
                doc.font('Helvetica').text(truncatedAssignee, 105, infoY);

                if (deadline) {
                    const deadlineStr = deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Deadline:', 260, infoY);
                    doc.font('Helvetica').fillColor(isOverdue ? red : gray).text(deadlineStr, 310, infoY);
                }

                infoY += 18;

                // Row 2: Completed and Created dates
                if (status === 'completed' && completedAt) {
                    const completedStr = completedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Completed:', 52, infoY);
                    doc.font('Helvetica').fillColor(green).text(completedStr, 112, infoY);
                }

                if (createdAt) {
                    const createdStr = createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Created:', 260, infoY);
                    doc.font('Helvetica').fillColor(gray).text(createdStr, 310, infoY);
                }

                y += 125; // Card height + gap
            }
        }

        // =========== FOOTER (on all pages) ===========
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);

            // Footer line
            doc.moveTo(40, 780).lineTo(pageWidth - 40, 780).stroke(borderGray);

            // Footer text
            doc.fontSize(8).font('Helvetica').fillColor(gray).text(
                `TODO: Manager Report`,
                40, 790
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
