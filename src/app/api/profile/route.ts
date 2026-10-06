import { ok, parseBody, withAuth } from '@/server/api/http';
import {
  getProfileOverview,
  updateProfile,
} from '@/server/services/profileService';
import { updateProfileSchema } from '@/lib/validation/user';

// The signed-in user's own account overview (used by the Android app's
// Profile screen; the web page reads it server-side).
export const GET = withAuth(async (ctx) => {
  const overview = await getProfileOverview(ctx.user.id);
  return ok(overview);
});

export const PATCH = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, updateProfileSchema);
  const overview = await updateProfile(ctx.user.id, input);
  return ok(overview);
});
