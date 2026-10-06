import { ok, parseBody, rateLimit, requirePermission, withAuth, fail } from '@/server/api/http';
import { submitBugReport } from '@/server/services/bugReportService';
import { submitBugReportSchema } from '@/lib/validation/bugReport';

// File a bug report from the website or the Android app. The head is notified
// in-app and support is emailed (see bugReportService).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bugs:report');
  // Each report can send an email; keep a tight per-user budget on top of the
  // generic per-IP limit in withAuth.
  if (!rateLimit(`bug-report:${ctx.user.id}`, 60 * 60_000, 10)) {
    return fail('Too many bug reports — try again later.', 429);
  }
  const input = await parseBody(ctx.req, submitBugReportSchema);
  const result = await submitBugReport(
    ctx.user.householdId!,
    { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
    input,
    { userAgent: ctx.req.headers.get('user-agent') ?? undefined },
  );
  return ok(result, { status: 201 });
});
