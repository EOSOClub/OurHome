import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { itemToDTO, updateInventoryItem } from '@/server/services/inventoryService';
import { updateInventoryItemSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'inventory:write');
  const input = await parseBody(ctx.req, updateInventoryItemSchema);
  const item = await updateInventoryItem(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item));
});
