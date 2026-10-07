import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteInventoryCategory } from '@/server/services/inventoryService';
import { categoryIdSchema } from '@/lib/validation/inventory';

export const POST = withAuth(async (ctx) => {
  // Categories have no creator, so removing one counts as deleting others'.
  await requireModify(ctx, 'inventory', 'delete', null);
  const { categoryId } = await parseBody(ctx.req, categoryIdSchema);
  await deleteInventoryCategory(ctx.user.householdId!, ctx.user.id, categoryId);
  return ok({ id: categoryId });
});
