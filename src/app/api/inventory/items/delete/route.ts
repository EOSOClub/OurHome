import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteInventoryItem } from '@/server/services/inventoryService';
import { recordOwner } from '@/server/services/permissionService';
import { itemIdSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { itemId } = await parseBody(ctx.req, itemIdSchema);
  await requireModify(
    ctx,
    'inventory',
    'delete',
    await recordOwner.inventoryItem(householdId, itemId),
  );
  await deleteInventoryItem(householdId, ctx.user.id, itemId);
  return ok({ id: itemId });
});
