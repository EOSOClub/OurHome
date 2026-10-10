import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { getServerSession } from '@/server/auth/session';
import { getAccessSettings, setAccessSettings } from '@/server/services/accessService';
import { accessSettingsSchema } from '@/lib/validation/user';

// "HTTPS only" is server-wide, so it belongs to the server admin (the path is
// kept for existing clients).
export const GET = withServerAdmin(async (ctx) => {
  return ok(await getAccessSettings(ctx.req.headers));
});

export const PUT = withServerAdmin(async (ctx) => {
  const { allowHttp } = await parseBody(ctx.req, accessSettingsSchema);
  const session = await getServerSession();
  const settings = await setAccessSettings(ctx.user.id, allowHttp, session?.session.id ?? null, ctx.req.headers);
  return ok(settings);
});
