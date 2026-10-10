import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { saveFloor } from '@/server/services/placeService';
import { saveFloorSchema } from '@/lib/validation/place';

// Add a floor, or rename one (with `id`). Head of House and managers.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, saveFloorSchema);
  return ok(await saveFloor(ctx.user.householdId!, ctx.user.id, input));
});
