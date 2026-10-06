import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { setItemPurchased, itemToDTO } from '@/server/services/shoppingService';
import { setItemPurchasedSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'shopping:write');
  const input = await parseBody(ctx.req, setItemPurchasedSchema);
  const item = await setItemPurchased(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item));
});
