import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { clearPurchased, listToDTO } from '@/server/services/shoppingService';
import { listIdSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'shopping:write');
  const { listId } = await parseBody(ctx.req, listIdSchema);
  const list = await clearPurchased(ctx.user.householdId!, ctx.user.id, listId);
  return ok(listToDTO(list));
});
