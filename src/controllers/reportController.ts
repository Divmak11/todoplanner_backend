import * as functions from 'firebase-functions';
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

/**
 * Export tasks report as PDF
 * Only Super Admin can export reports
 */
export const exportReport = functions.region('asia-south1').https.onCall(
    async (data: ExportReportInput, context: functions.https.CallableContext) => {
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

            // Fetch user data for assignee names
            const userIds = [...new Set(tasks.map((task: any) => task.assignedTo))];
            const usersMap: Record<string, string> = {};

            for (const userId of userIds) {
                const userDoc = await db.collection(Collections.USERS).doc(userId).get();
                if (userDoc.exists) {
                    usersMap[userId] = userDoc.data()!.name || 'Unknown';
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
            throw new functions.https.HttpsError(
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
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks: Buffer[] = [];

        // Collect PDF data
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Colors
        const primaryBlue = '#1e40af';
        const lightBlue = '#3b82f6';
        const green = '#22c55e';
        const yellow = '#eab308';
        const red = '#ef4444';
        const gray = '#64748b';
        const lightGray = '#f1f5f9';

        // =========== HEADER ===========
        // Gradient header background
        doc.rect(0, 0, 595, 120).fill(primaryBlue);

        doc
            .fontSize(28)
            .font('Helvetica-Bold')
            .fillColor('white')
            .text('TODO PLANNER', 50, 40)
            .fontSize(14)
            .font('Helvetica')
            .text('Task Management Report', 50, 75);

        // Move below header
        doc.fillColor('black').fontSize(10);
        let y = 150;

        // =========== REPORT INFO ===========
        if (filters.startDate && filters.endDate) {
            doc
                .fontSize(11)
                .font('Helvetica-Bold')
                .text(
                    `Report Period: ${filters.startDate.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                    })} - ${filters.endDate.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                    })}`,
                    50,
                    y
                );
            y += 20;
        }

        if (filters.status !== 'all') {
            doc.fontSize(10).font('Helvetica').fillColor(gray).text(`Status Filter: ${filters.status}`, 50, y);
            y += 15;
        }

        y += 10;

        // =========== SUMMARY STATISTICS BOX ===========
        const completedCount = tasks.filter((t) => t.status === 'completed').length;
        const ongoingCount = tasks.filter((t) => t.status === 'ongoing').length;
        const cancelledCount = tasks.filter((t) => t.status === 'cancelled').length;
        const completionRate = tasks.length > 0 ? ((completedCount / tasks.length) * 100).toFixed(1) : '0';

        // Summary box background
        doc.rect(50, y, 495, 80).fillAndStroke(lightGray, gray);
        y += 15;

        doc.fontSize(12).font('Helvetica-Bold').fillColor(primaryBlue).text('📊 Summary Statistics', 65, y);
        y += 25;

        doc.fontSize(10).font('Helvetica').fillColor('black');
        doc.text(`Total Tasks: ${tasks.length}`, 65, y);
        doc.text(`Completed: ${completedCount} (${completionRate}%)`, 200, y);
        doc.text(`Ongoing: ${ongoingCount}`, 380, y);
        y += 15;
        doc.text(`Cancelled: ${cancelledCount}`, 65, y);

        y += 40;

        // =========== TABLE HEADER ===========
        doc.fontSize(11).font('Helvetica-Bold').fillColor('white');

        // Header background
        doc.rect(50, y, 495, 25).fill(lightBlue);

        const headerY = y + 7;
        doc.text('Task Title', 55, headerY, { width: 200 });
        doc.text('Assignee', 260, headerY, { width: 110 });
        doc.text('Status', 380, headerY, { width: 70 });
        doc.text('Deadline', 460, headerY, { width: 80 });

        y += 30;

        // =========== TABLE ROWS ===========
        doc.font('Helvetica').fontSize(9).fillColor('black');

        let rowIndex = 0;
        for (const task of tasks) {
            // Check if we need a new page
            if (y > 700) {
                doc.addPage();
                y = 50;
                rowIndex = 0;
            }

            // Alternating row colors
            if (rowIndex % 2 === 0) {
                doc.rect(50, y - 2, 495, 22).fill('#fafafa');
            }

            const title = (task.title || 'Untitled').substring(0, 40);
            const assignee = (usersMap[task.assignedTo] || 'Unknown').substring(0, 20);
            const status = task.status || 'N/A';
            const deadline = task.deadline?.toDate ? task.deadline.toDate().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'N/A';

            // Status with color indicator
            let statusColor = gray;
            let statusIcon = '◉';
            if (status === 'completed') {
                statusColor = green;
                statusIcon = '✓';
            } else if (status === 'ongoing') {
                statusColor = yellow;
                statusIcon = '→';
            } else if (status === 'cancelled') {
                statusColor = red;
                statusIcon = '✕';
            }

            doc.fillColor('black').text(title, 55, y, { width: 190 });
            doc.text(assignee, 260, y, { width: 110 });
            doc.fillColor(statusColor).text(`${statusIcon} ${status}`, 380, y, { width: 70 });
            doc.fillColor('black').text(deadline, 460, y, { width: 80 });

            y += 22;
            rowIndex++;
        }

        // =========== FOOTER (on all pages) ===========
        const pageCount = doc.bufferedPageRange().count;
        for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc
                .fontSize(8)
                .fillColor(gray)
                .text(
                    `Generated on ${new Date().toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                    })} | Page ${i + 1} of ${pageCount}`,
                    50,
                    750,
                    { align: 'center', width: 495 }
                );
        }

        doc.end();
    });
}
