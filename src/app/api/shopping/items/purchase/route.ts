import { ok, parseBody, requireAnyAccess, withAuth } from '@/server/api/http';
import { setItemPurchased, itemToDTO } from '@/server/services/shoppingService';
import { setItemPurchasedSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  // Ticking an item off isn't an edit: anyone with Shopping access may.
  await requireAnyAccess(ctx, 'shopping');
  const input = await parseBody(ctx.req, setItemPurchasedSchema);
  const item = await setItemPurchased(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item));
});
