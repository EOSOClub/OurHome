import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { renameShoppingList, listToDTO } from '@/server/services/shoppingService';
import { recordOwner } from '@/server/services/permissionService';
import { renameShoppingListSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, renameShoppingListSchema);
  await requireModify(
    ctx,
    'shopping',
    'edit',
    await recordOwner.shoppingList(householdId, input.listId),
  );
  const list = await renameShoppingList(householdId, ctx.user.id, input);
  return ok(listToDTO(list));
});
