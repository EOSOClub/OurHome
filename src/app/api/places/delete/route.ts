import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deletePlace } from '@/server/services/placeService';
import { deletePlaceSchema } from '@/lib/validation/place';

// Remove a floor or room; its tasks move up a level (placeService.deletePlace).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, deletePlaceSchema);
  return ok(await deletePlace(ctx.user.householdId!, ctx.user.id, input));
});
