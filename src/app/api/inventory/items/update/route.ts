import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { itemToDTO, updateInventoryItem } from '@/server/services/inventoryService';
import { recordOwner } from '@/server/services/permissionService';
import { updateInventoryItemSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateInventoryItemSchema);
  await requireModify(
    ctx,
    'inventory',
    'edit',
    await recordOwner.inventoryItem(householdId, input.itemId),
  );
  const item = await updateInventoryItem(householdId, ctx.user.id, input);
  return ok(itemToDTO(item));
});
