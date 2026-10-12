import { ok, parseBody, withAuth } from '@/server/api/http';
import { getLocationConsent, updateLocationConsent } from '@/server/services/locationService';
import { updateLocationConsentSchema } from '@/lib/validation/location';

// The signed-in member's own location sharing and live-check consent
// (Profile → Location on the web; the Android app reads it too).
export const GET = withAuth(async (ctx) => ok(await getLocationConsent(ctx.user.id)));

export const PATCH = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, updateLocationConsentSchema);
  return ok(await updateLocationConsent(ctx.user.id, input));
});
