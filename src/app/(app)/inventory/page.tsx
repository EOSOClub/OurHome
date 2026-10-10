import { requireFeature } from '@/server/auth/session';
import { getUserAccess } from '@/server/services/permissionService';
import {
  itemToDTO,
  listInventoryCategories,
  listInventoryItems,
} from '@/server/services/inventoryService';
import { InventoryView } from '@/components/inventory/inventory-view';

export default async function InventoryPage() {
  const user = await requireFeature('inventory');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const [items, categories] = await Promise.all([
    listInventoryItems(householdId),
    listInventoryCategories(householdId),
  ]);

  return (
    <InventoryView
      initialItems={items.map(itemToDTO)}
      categories={categories}
      access={access.inventory}
      userId={user.id}
      canAddToShopping={access.shopping.create}
    />
  );
}
