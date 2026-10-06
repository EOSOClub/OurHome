import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteCategory } from '@/server/services/categoryService';
import { categoryIdSchema } from '@/lib/validation/category';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const { id } = await parseBody(ctx.req, categoryIdSchema);
  await deleteCategory(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
