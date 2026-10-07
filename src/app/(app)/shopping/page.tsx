import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import {
  listShoppingLists,
  listToDTO,
} from '@/server/services/shoppingService';
import { ShoppingView } from '@/components/shopping/shopping-view';

export default async function ShoppingPage() {
  const user = await requireUser();
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const [lists, categories] = await Promise.all([
    listShoppingLists(householdId),
    prisma.category.findMany({
      where: { householdId, kind: 'shopping' },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <ShoppingView
      initialLists={lists.map(listToDTO)}
      categories={categories}
      access={access.shopping}
      userId={user.id}
    />
  );
}
