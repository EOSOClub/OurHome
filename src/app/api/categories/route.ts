import {
  ok,
  parseBody,
  parseQuery,
  requirePermission,
  withAuth,
} from '@/server/api/http';
import { createCategory, listCategories } from '@/server/services/categoryService';
import {
  createCategorySchema,
  listCategoriesQuerySchema,
} from '@/lib/validation/category';

export const GET = withAuth(async (ctx) => {
  const query = parseQuery(ctx.req, listCategoriesQuerySchema);
  const categories = await listCategories(ctx.user.householdId!, query);
  return ok(categories);
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, createCategorySchema);
  const category = await createCategory(ctx.user.householdId!, ctx.user.id, input);
  return ok(category, { status: 201 });
});
