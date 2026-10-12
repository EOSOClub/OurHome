import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { listMapPlaces, saveMapPlace } from '@/server/services/mapPlaceService';
import { saveMapPlaceSchema } from '@/lib/validation/location';

// Every map place, home first. Anyone in the household (the Android app
// reads them to set up its geofences).
export const GET = withAuth(async (ctx) => ok(await listMapPlaces(ctx.user.householdId!)));

// Add a map place, or change one (with `id`). Head of House and managers.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, saveMapPlaceSchema);
  return ok(await saveMapPlace(ctx.user.householdId!, ctx.user.id, input));
});
