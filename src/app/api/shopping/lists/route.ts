import { ok, parseBody, requireCreate, withAuth } from '@/server/api/http';
import {
  createShoppingList,
  listShoppingLists,
  listToDTO,
} from '@/server/services/shoppingService';
import { createShoppingListSchema } from '@/lib/validation/shopping';

export const GET = withAuth(async ({ user }) => {
  const lists = await listShoppingLists(user.householdId!);
  return ok(lists.map(listToDTO));
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'shopping');
  const input = await parseBody(ctx.req, createShoppingListSchema);
  const list = await createShoppingList(ctx.user.householdId!, ctx.user.id, input);
  return ok(listToDTO(list), { status: 201 });
});
