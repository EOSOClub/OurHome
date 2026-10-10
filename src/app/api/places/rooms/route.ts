import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { saveRoom } from '@/server/services/placeService';
import { saveRoomSchema } from '@/lib/validation/place';

// Add a room, or rename / move one to another floor (with `id`). Head of
// House and managers.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, saveRoomSchema);
  return ok(await saveRoom(ctx.user.householdId!, ctx.user.id, input));
});
