import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updateShoppingItem, itemToDTO } from '@/server/services/shoppingService';
import { recordOwner } from '@/server/services/permissionService';
import { updateShoppingItemSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateShoppingItemSchema);
  await requireModify(
    ctx,
    'shopping',
    'edit',
    await recordOwner.shoppingItem(householdId, input.itemId),
  );
  const item = await updateShoppingItem(householdId, ctx.user.id, input);
  return ok(itemToDTO(item));
});
