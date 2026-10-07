import { ok, parseBody, requireAnyAccess, withAuth } from '@/server/api/http';
import { adjustQuantity, itemToDTO } from '@/server/services/inventoryService';
import { adjustQuantitySchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  // Using up or restocking isn't an edit: anyone with Inventory access may.
  await requireAnyAccess(ctx, 'inventory');
  const input = await parseBody(ctx.req, adjustQuantitySchema);
  const item = await adjustQuantity(
    ctx.user.householdId!,
    ctx.user.id,
    input.itemId,
    input.delta,
    { note: input.note, source: 'web' },
  );
  return ok(itemToDTO(item));
});
