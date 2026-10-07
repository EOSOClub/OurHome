import { ok, parseBody, requireCreate, withAuth } from '@/server/api/http';
import {
  createInventoryCategory,
  listInventoryCategories,
} from '@/server/services/inventoryService';
import { createInventoryCategorySchema } from '@/lib/validation/inventory';

export const GET = withAuth(async (ctx) => {
  const categories = await listInventoryCategories(ctx.user.householdId!);
  return ok(categories);
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'inventory');
  const input = await parseBody(ctx.req, createInventoryCategorySchema);
  const category = await createInventoryCategory(
    ctx.user.householdId!,
    ctx.user.id,
    input,
  );
  return ok(category, { status: 201 });
});
