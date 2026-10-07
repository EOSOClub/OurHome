import { prisma } from '@/server/db/prisma';
import { isEmailConfigured, sendEmail } from '@/server/email/mailer';
import { pushSync } from '@/server/services/pushService';
import { can } from '@/lib/permissions';
import type { SubmitBugReportInput } from '@/lib/validation/bugReport';

// Where bug reports are emailed (BUG_REPORT_EMAIL). Unset → reports are still
// stored and the head is notified in-app; the email is skipped and logged.
const SUPPORT_TO = process.env.BUG_REPORT_EMAIL?.trim() || null;

interface Reporter {
  id: string;
  name: string;
  email: string;
}

/**
 * File a bug report: store it, notify everyone holding bugs:manage (the head)
 * with an in-app notification addressed to them, then email a copy to
 * SUPPORT_TO. The row and notification are written first, so an unconfigured
 * or failing mailer never loses a report — the outcome is logged and recorded
 * in `emailStatus`, and the caller still gets success.
 */
export async function submitBugReport(
  householdId: string,
  reporter: Reporter,
  input: SubmitBugReportInput,
  meta: { userAgent?: string } = {},
): Promise<{ id: string }> {
  const report = await prisma.bugReport.create({
    data: {
      householdId,
      reporterId: reporter.id,
      title: input.title,
      description: input.description,
      source: input.source,
      context: input.context ?? null,
      appVersion: input.appVersion ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  const members = await prisma.user.findMany({
    where: { householdId },
    select: { id: true, role: true },
  });
  const recipients = members.filter((m) => can(m.role, 'bugs:manage'));
  if (recipients.length > 0) {
    await prisma.notification.createMany({
      data: recipients.map((r) => ({
        householdId,
        userId: r.id,
        type: 'bug_report',
        title: `Bug report: ${input.title}`,
        body: `From ${reporter.name} (${input.source === 'android' ? 'app' : 'website'}). ${truncate(input.description, 140)}`,
        channel: 'in_app',
        subjectType: 'bug_report',
        subjectId: report.id,
        readAt: null,
      })),
    });
    pushSync(householdId, { userIds: recipients.map((r) => r.id) }, 'bug_report');
  }

  await emailSupport(report.id, reporter, input, meta);
  return { id: report.id };
}

async function emailSupport(
  reportId: string,
  reporter: Reporter,
  input: SubmitBugReportInput,
  meta: { userAgent?: string },
) {
  if (!SUPPORT_TO || !isEmailConfigured()) {
    console.warn(
      `[bug-report] ${SUPPORT_TO ? 'SMTP not configured' : 'BUG_REPORT_EMAIL not set'}; report ${reportId} was not emailed.`,
    );
    await setEmailStatus(reportId, 'not_configured');
    return;
  }
  try {
    await sendEmail({
      to: SUPPORT_TO,
      replyTo: reporter.email,
      subject: `[Bug] ${input.title}`,
      text: [
        `Bug report from ${reporter.name} <${reporter.email}>`,
        `Source: ${input.source}${input.appVersion ? ` (app ${input.appVersion})` : ''}`,
        `Where: ${input.context ?? 'not given'}`,
        '',
        input.description,
        '',
        '---',
        `Report id: ${reportId}`,
        `User-Agent: ${meta.userAgent ?? 'unknown'}`,
        '',
        'Reply to this email to respond to the reporter.',
      ].join('\n'),
    });
    await setEmailStatus(reportId, 'emailed');
  } catch (err) {
    console.error(`[bug-report] failed to email report ${reportId} to ${SUPPORT_TO}:`, err);
    await setEmailStatus(reportId, 'email_failed');
  }
}

async function setEmailStatus(id: string, emailStatus: string) {
  await prisma.bugReport.update({ where: { id }, data: { emailStatus } }).catch((err) => {
    console.error(`[bug-report] could not record email status for ${id}:`, err);
  });
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
