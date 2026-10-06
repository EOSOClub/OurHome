import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteInventoryItem } from '@/server/services/inventoryService';
import { itemIdSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'inventory:write');
  const { itemId } = await parseBody(ctx.req, itemIdSchema);
  await deleteInventoryItem(ctx.user.householdId!, ctx.user.id, itemId);
  return ok({ id: itemId });
});
