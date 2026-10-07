import { getAccess, ok, parseBody, requireAnyAccess, withAuth } from '@/server/api/http';
import { clearPurchased, listToDTO } from '@/server/services/shoppingService';
import { canModify } from '@/lib/permissions';
import { listIdSchema } from '@/lib/validation/shopping';

// Clearing removes only the purchased items the caller may delete; the rest
// (and every recurring item, which is just un-checked) stay put.
export const POST = withAuth(async (ctx) => {
  await requireAnyAccess(ctx, 'shopping');
  const access = (await getAccess(ctx)).shopping;
  const { listId } = await parseBody(ctx.req, listIdSchema);
  const list = await clearPurchased(ctx.user.householdId!, ctx.user.id, listId, (ownerId) =>
    canModify(access, 'delete', ownerId, ctx.user.id),
  );
  return ok(listToDTO(list));
});
