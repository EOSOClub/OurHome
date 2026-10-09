import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getPointsSettings, updatePointsSettings } from '@/server/services/pointsService';
import { pointsSettingsSchema } from '@/lib/validation/points';

// Points rate, time zone and week start. Everyone can read them (editors need
// the rate); only the head (household:manage) changes them. Changing the rate
// doesn't touch existing tasks: their values are stored.
export const GET = withAuth(async ({ user }) => ok(await getPointsSettings(user.householdId!)));

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, pointsSettingsSchema);
  return ok(await updatePointsSettings(ctx.user.householdId!, input));
});
