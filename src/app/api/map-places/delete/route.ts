import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteMapPlace } from '@/server/services/mapPlaceService';
import { deleteMapPlaceSchema } from '@/lib/validation/location';

// Remove a map place. Head of House and managers.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, deleteMapPlaceSchema);
  return ok(await deleteMapPlace(ctx.user.householdId!, ctx.user.id, input));
});
