import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getServerSession } from '@/server/auth/session';
import { getAccessSettings, setAccessSettings } from '@/server/services/accessService';
import { accessSettingsSchema } from '@/lib/validation/user';

export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await getAccessSettings(ctx.user.householdId!, ctx.req.headers));
});

export const PUT = withAuth(async (ctx) => {
  // Only the head holds household:manage; the service double-checks.
  requirePermission(ctx, 'household:manage');
  const { allowHttp } = await parseBody(ctx.req, accessSettingsSchema);
  const session = await getServerSession();
  const settings = await setAccessSettings(
    ctx.user.householdId!,
    ctx.user,
    allowHttp,
    session?.session.id ?? null,
    ctx.req.headers,
  );
  return ok(settings);
});
