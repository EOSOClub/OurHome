import { ok, parseBody, requireCreate, withAuth } from '@/server/api/http';
import {
  createInventoryItem,
  itemToDTO,
  listInventoryItems,
} from '@/server/services/inventoryService';
import { createInventoryItemSchema } from '@/lib/validation/inventory';

export const GET = withAuth(async (ctx) => {
  const items = await listInventoryItems(ctx.user.householdId!);
  return ok(items.map(itemToDTO));
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'inventory');
  const input = await parseBody(ctx.req, createInventoryItemSchema);
  const item = await createInventoryItem(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item), { status: 201 });
});
