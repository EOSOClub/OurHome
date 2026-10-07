import { ok, parseBody, requireCreate, withAuth } from '@/server/api/http';
import { addShoppingItem, itemToDTO } from '@/server/services/shoppingService';
import { addShoppingItemSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'shopping');
  const input = await parseBody(ctx.req, addShoppingItemSchema);
  const item = await addShoppingItem(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item), { status: 201 });
});
