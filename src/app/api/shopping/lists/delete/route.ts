import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteShoppingList } from '@/server/services/shoppingService';
import { recordOwner } from '@/server/services/permissionService';
import { listIdSchema } from '@/lib/validation/shopping';

// Deleting a list removes every item on it, whoever added them.
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { listId } = await parseBody(ctx.req, listIdSchema);
  await requireModify(
    ctx,
    'shoppingLists',
    'delete',
    await recordOwner.shoppingList(householdId, listId),
  );
  await deleteShoppingList(householdId, ctx.user.id, listId);
  return ok({ id: listId });
});
