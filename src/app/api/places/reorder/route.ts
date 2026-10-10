import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { reorderPlaces } from '@/server/services/placeService';
import { reorderPlacesSchema } from '@/lib/validation/place';

// The new order of the floors, or of the rooms on one floor.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, reorderPlacesSchema);
  return ok(await reorderPlaces(ctx.user.householdId!, input));
});
