import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteInventoryCategory } from '@/server/services/inventoryService';
import { categoryIdSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'inventory:write');
  const { categoryId } = await parseBody(ctx.req, categoryIdSchema);
  await deleteInventoryCategory(ctx.user.householdId!, ctx.user.id, categoryId);
  return ok({ id: categoryId });
});
