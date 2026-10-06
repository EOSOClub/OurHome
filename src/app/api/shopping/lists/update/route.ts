import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { renameShoppingList, listToDTO } from '@/server/services/shoppingService';
import { renameShoppingListSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'shopping:write');
  const input = await parseBody(ctx.req, renameShoppingListSchema);
  const list = await renameShoppingList(ctx.user.householdId!, ctx.user.id, input);
  return ok(listToDTO(list));
});
