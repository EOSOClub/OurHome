import { ok, parseBody, withAuth } from '@/server/api/http';
import { listPresence, reportPresence } from '@/server/services/locationService';
import { reportPresenceSchema } from '@/lib/validation/location';

// Who is where: the members who share their location. Anyone in the household.
export const GET = withAuth(async (ctx) => ok(await listPresence(ctx.user.householdId!)));

// The signed-in member's phone arrived at or left a map place (Android app
// geofences). Answers with a store reminder for the phone to show, if any.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportPresenceSchema);
  return ok(await reportPresence(ctx.user.householdId!, ctx.user.id, input));
});
