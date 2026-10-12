import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getSupervision, setSupervisors } from '@/server/services/supervisionService';
import { setSupervisorsSchema } from '@/lib/validation/supervision';

// The head's supervision list (parental controls): who supervises which kid.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await getSupervision(ctx.user.householdId!));
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, setSupervisorsSchema);
  return ok(await setSupervisors(ctx.user.householdId!, ctx.user, input));
});
