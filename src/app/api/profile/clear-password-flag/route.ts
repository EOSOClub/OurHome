import { ok, withAuth } from '@/server/api/http';

// Kept for clients that call it after changing their password. It changes
// nothing any more: the forced-change flag is lifted by the change-password
// hook in src/server/auth/auth.ts, so it can't be skipped by calling this.
// Reports whether the gate is still up.
export const POST = withAuth(async (ctx) => {
  return ok({ ok: true, mustChangePassword: ctx.user.mustChangePassword });
});
