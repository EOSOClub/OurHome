import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getLiveCheckSettings, updateLiveCheckSettings } from '@/server/services/liveCheckService';
import { liveCheckSettingsSchema } from '@/lib/validation/location';

// How long a live check may run and how often it may ask. Everyone can read
// them (the start dialog offers what fits); only the head changes them.
export const GET = withAuth(async ({ user }) => ok(await getLiveCheckSettings(user.householdId!)));

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, liveCheckSettingsSchema);
  return ok(await updateLiveCheckSettings(ctx.user.householdId!, input));
});
