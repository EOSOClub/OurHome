import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateCategory } from '@/server/services/categoryService';
import { updateCategorySchema } from '@/lib/validation/category';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, updateCategorySchema);
  const category = await updateCategory(ctx.user.householdId!, ctx.user.id, input);
  return ok(category);
});
