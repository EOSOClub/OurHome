import { ok, withAuth } from '@/server/api/http';
import { clearMustChangePassword } from '@/server/services/profileService';

// Called by the client right after a successful password change to lift the
// forced-change gate (see ForcedPasswordChange / the (app) layout redirect).
export const POST = withAuth(async (ctx) => {
  await clearMustChangePassword(ctx.user.id);
  return ok({ ok: true });
});
