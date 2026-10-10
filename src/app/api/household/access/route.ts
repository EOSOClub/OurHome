import { ok, parseBody, withAuth } from '@/server/api/http';
import { getServerSession } from '@/server/auth/session';
import { getAccessSettings, setAccessSettings } from '@/server/services/accessService';
import { assertServerAdmin } from '@/server/services/serverAdminService';
import { accessSettingsSchema } from '@/lib/validation/user';

// "HTTPS only" is server-wide, so it belongs to the server admin (the path is
// kept for existing clients).
export const GET = withAuth(async (ctx) => {
  await assertServerAdmin(ctx.user.id);
  return ok(await getAccessSettings(ctx.req.headers));
});

export const PUT = withAuth(async (ctx) => {
  await assertServerAdmin(ctx.user.id);
  const { allowHttp } = await parseBody(ctx.req, accessSettingsSchema);
  const session = await getServerSession();
  const settings = await setAccessSettings(ctx.user.id, allowHttp, session?.session.id ?? null, ctx.req.headers);
  return ok(settings);
});
