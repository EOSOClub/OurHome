import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { adjustQuantity, itemToDTO } from '@/server/services/inventoryService';
import { adjustQuantitySchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'inventory:write');
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
