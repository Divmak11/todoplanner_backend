import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import PDFDocument from 'pdfkit';
import { admin, db } from '../config/firebase-admin';
import { Collections } from '../config/constants';
import { validateSuperAdminAsync } from '../utils/validators';

interface ExportReportInput {
    startDate: string; // ISO date string
    endDate: string; // ISO date string
    teamId?: string;
    status?: string;
}

// 2nd Gen configuration for report function - increased memory for PDF generation
const reportConfig = {
    region: 'asia-south1',
    memory: '512MiB' as const,
    timeoutSeconds: 120
};

/**
 * Export tasks report as PDF
 * Only Super Admin can export reports
 */
export const exportReport = onCall(
    reportConfig,
    async (request: CallableRequest<ExportReportInput>) => {
        const data = request.data;
        const context = { auth: request.auth };

        // Validate caller is super admin
        await validateSuperAdminAsync(context);

        const startDate = data.startDate ? new Date(data.startDate) : null;
        const endDate = data.endDate ? new Date(data.endDate) : null;
        const teamId = data.teamId || 'all';
        const status = data.status || 'all';

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

            // Filter by team (in-memory to avoid Firestore 'in' limit)
            if (teamId !== 'all') {
                const teamDoc = await db.collection(Collections.TEAMS).doc(teamId).get();
                if (teamDoc.exists) {
                    const memberIds = teamDoc.data()!.memberIds || [];
                    tasks = tasks.filter((task: any) => memberIds.includes(task.assignedTo));
                }
            }

            // Filter by status
            if (status !== 'all') {
                tasks = tasks.filter((task: any) => task.status === status);
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

            // Generate PDF
            const pdfBuffer = await generateTasksPDF(tasks, usersMap, {
                startDate,
                endDate,
                teamId,
                status,
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
    filters: any
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
            doc.font('Helvetica-Bold').text('Team Filter: ', 40, y, { continued: true });
            doc.font('Helvetica').text('Specific Team');
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

                // Card background - increased height to accommodate two info rows
                const taskCardHeight = 100;
                doc.rect(40, y, contentWidth, taskCardHeight).fill('#ffffff');
                doc.rect(40, y, contentWidth, taskCardHeight).stroke(borderGray);

                // Left accent bar based on status
                doc.rect(40, y, 4, taskCardHeight).fill(statusText);

                // Task title
                doc.fontSize(12).font('Helvetica-Bold').fillColor(darkGray).text(
                    title.length > 60 ? title.substring(0, 60) + '...' : title,
                    52, y + 12, { width: contentWidth - 130 }
                );

                // Status badge (top right)
                const badgeWidth = doc.widthOfString(statusLabel) + 16;
                doc.rect(40 + contentWidth - badgeWidth - 10, y + 10, badgeWidth, 20).fill(statusBg);
                doc.fontSize(9).font('Helvetica-Bold').fillColor(statusText).text(
                    statusLabel,
                    40 + contentWidth - badgeWidth - 10, y + 15,
                    { width: badgeWidth, align: 'center' }
                );

                // Subtitle/Description (truncated)
                if (subtitle) {
                    doc.fontSize(9).font('Helvetica').fillColor(gray).text(
                        subtitle.length > 80 ? subtitle.substring(0, 80) + '...' : subtitle,
                        52, y + 32, { width: contentWidth - 70 }
                    );
                }

                // Bottom info row - use separate lines to avoid text overlap
                let infoY = y + 55;
                doc.fontSize(8).font('Helvetica').fillColor(gray);

                // Row 1: Assignee and Deadline on same line with fixed widths
                doc.font('Helvetica-Bold').text('Assignee: ', 52, infoY, { continued: true });
                doc.font('Helvetica').text(assignee.length > 18 ? assignee.substring(0, 18) + '...' : assignee, { continued: false });

                // Deadline on the right side of row 1
                if (deadline) {
                    const deadlineStr = deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Deadline: ', 280, infoY, { continued: true });
                    doc.font('Helvetica').fillColor(isOverdue ? red : gray).text(deadlineStr, { continued: false });
                }

                infoY += 12; // Move to second row

                // Row 2: Completed date and Created date
                if (status === 'completed' && completedAt) {
                    const completedStr = completedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Completed: ', 52, infoY, { continued: true });
                    doc.font('Helvetica').fillColor(green).text(completedStr, { continued: false });
                }

                if (createdAt) {
                    const createdStr = createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    doc.font('Helvetica-Bold').fillColor(gray).text('Created: ', 280, infoY, { continued: true });
                    doc.font('Helvetica').fillColor(gray).text(createdStr, { continued: false });
                }

                y += 110; // Card height + gap
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
