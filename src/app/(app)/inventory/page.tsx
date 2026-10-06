import { requireUser } from '@/server/auth/session';
import { can } from '@/lib/permissions';
import {
  itemToDTO,
  listInventoryCategories,
  listInventoryItems,
} from '@/server/services/inventoryService';
import { InventoryView } from '@/components/inventory/inventory-view';

export default async function InventoryPage() {
  const user = await requireUser();
  const householdId = user.householdId!;

  const [items, categories] = await Promise.all([
    listInventoryItems(householdId),
    listInventoryCategories(householdId),
  ]);

  return (
    <InventoryView
      initialItems={items.map(itemToDTO)}
      categories={categories}
      canWrite={can(user.role, 'inventory:write')}
    />
  );
}
