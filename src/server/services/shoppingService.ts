import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { ShoppingItemDTO, ShoppingListDTO } from '@/lib/types';
import type {
  AddShoppingItemInput,
  CreateShoppingListInput,
  RenameShoppingListInput,
  SetItemPurchasedInput,
  UpdateShoppingItemInput,
} from '@/lib/validation/shopping';
import { logActivity } from '@/server/services/activityService';
import { fetchLinkPreview } from '@/server/services/linkPreview';
import { NotFoundError } from '@/server/services/errors';

type Db = typeof prisma | Prisma.TransactionClient;

const itemInclude = {
  category: { select: { id: true, name: true, color: true } },
} satisfies Prisma.ShoppingItemInclude;

export type ShoppingItemWithRelations = Prisma.ShoppingItemGetPayload<{
  include: typeof itemInclude;
}>;

const listInclude = {
  items: {
    include: itemInclude,
    // Open items first, then by priority, oldest first within each group.
    orderBy: [{ purchased: 'asc' }, { createdAt: 'asc' }] as const,
  },
} satisfies Prisma.ShoppingListInclude;

export type ShoppingListWithItems = Prisma.ShoppingListGetPayload<{
  include: typeof listInclude;
}>;

/** Map a Prisma shopping item (with relations) to the serializable client DTO. */
export function itemToDTO(item: ShoppingItemWithRelations): ShoppingItemDTO {
  return {
    id: item.id,
    listId: item.listId,
    name: item.name,
    quantity: item.quantity,
    priority: item.priority,
    notes: item.notes,
    url: item.url,
    imageUrl: item.imageUrl,
    estimatedPrice: item.estimatedPrice,
    recurring: item.recurring,
    purchased: item.purchased,
    purchasedAt: item.purchasedAt?.toISOString() ?? null,
    category: item.category
      ? { id: item.category.id, name: item.category.name, color: item.category.color }
      : null,
  };
}

export function listToDTO(list: ShoppingListWithItems): ShoppingListDTO {
  const purchasedCount = list.items.filter((i) => i.purchased).length;
  return {
    id: list.id,
    name: list.name,
    kind: list.kind,
    items: list.items.map(itemToDTO),
    openCount: list.items.length - purchasedCount,
    purchasedCount,
  };
}

export async function listShoppingLists(
  householdId: string,
): Promise<ShoppingListWithItems[]> {
  return prisma.shoppingList.findMany({
    where: { householdId },
    include: listInclude,
    orderBy: { createdAt: 'asc' },
  });
}

export async function createShoppingList(
  householdId: string,
  userId: string,
  input: CreateShoppingListInput,
): Promise<ShoppingListWithItems> {
  const list = await prisma.shoppingList.create({
    data: { householdId, name: input.name, kind: input.kind },
    include: listInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'shopping_list',
    subjectId: list.id,
    message: `created the “${list.name}” list`,
  });

  return list;
}

export async function renameShoppingList(
  householdId: string,
  userId: string,
  input: RenameShoppingListInput,
): Promise<ShoppingListWithItems> {
  const existing = await assertListInHousehold(input.listId, householdId);

  const list = await prisma.shoppingList.update({
    where: { id: input.listId },
    data: { name: input.name },
    include: listInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'shopping_list',
    subjectId: list.id,
    message: `renamed the “${existing.name}” list to “${list.name}”`,
  });

  return list;
}

export async function deleteShoppingList(
  householdId: string,
  userId: string,
  listId: string,
): Promise<void> {
  const list = await assertListInHousehold(listId, householdId);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.shoppingItem.deleteMany({ where: { listId } });
    await tx.shoppingList.delete({ where: { id: listId } });

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'deleted',
        subjectType: 'shopping_list',
        subjectId: listId,
        message: `deleted the “${list.name}” list`,
        metadata: { items: count },
      },
      tx,
    );
  });
}

export async function addShoppingItem(
  householdId: string,
  userId: string,
  input: AddShoppingItemInput,
): Promise<ShoppingItemWithRelations> {
  const list = await assertListInHousehold(input.listId, householdId);

  // Save-time fallback: a link was pasted but no preview image was attached in
  // the form, so best-effort fetch one now (returns null on Amazon's bot wall etc.).
  let imageUrl = input.imageUrl ?? null;
  if (input.url && !imageUrl) {
    imageUrl = (await fetchLinkPreview(input.url)).imageUrl;
  }

  const item = await prisma.shoppingItem.create({
    data: {
      listId: list.id,
      name: input.name,
      quantity: input.quantity,
      priority: input.priority,
      notes: input.notes ?? null,
      url: input.url ?? null,
      imageUrl,
      estimatedPrice: input.estimatedPrice ?? null,
      recurring: input.recurring,
      categoryId: input.categoryId ?? null,
    },
    include: itemInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'shopping_item',
    subjectId: item.id,
    message: `added “${item.name}” to ${list.name}`,
  });

  return item;
}

export async function updateShoppingItem(
  householdId: string,
  userId: string,
  input: UpdateShoppingItemInput,
): Promise<ShoppingItemWithRelations> {
  const { itemId, ...rest } = input;
  const existing = await findItemInHousehold(itemId, householdId);

  // Save-time fallback: when the link is newly set or changed without a preview
  // image, best-effort fetch one so attaching a URL still gets a thumbnail. Gated
  // on the URL actually changing so unrelated edits don't re-hit the network.
  let imageUrl = rest.imageUrl;
  if (rest.url && !rest.imageUrl && rest.url !== existing.url) {
    imageUrl = (await fetchLinkPreview(rest.url)).imageUrl;
  }

  const item = await prisma.shoppingItem.update({
    where: { id: itemId },
    data: {
      name: rest.name,
      quantity: rest.quantity,
      priority: rest.priority,
      notes: rest.notes,
      url: rest.url,
      imageUrl,
      estimatedPrice: rest.estimatedPrice,
      recurring: rest.recurring,
      categoryId: rest.categoryId,
    },
    include: itemInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'shopping_item',
    subjectId: item.id,
    message: `updated “${item.name}”`,
  });

  return item;
}

export async function setItemPurchased(
  householdId: string,
  userId: string,
  input: SetItemPurchasedInput,
): Promise<ShoppingItemWithRelations> {
  const existing = await findItemInHousehold(input.itemId, householdId);

  return prisma.$transaction(async (tx) => {
    const item = await tx.shoppingItem.update({
      where: { id: input.itemId },
      data: {
        purchased: input.purchased,
        purchasedAt: input.purchased ? new Date() : null,
      },
      include: itemInclude,
    });

    // Record household purchase history on the transition into "purchased".
    // Purchase has no back-link to the shopping item, so un-checking leaves the
    // history row in place rather than guessing which record to remove.
    if (input.purchased && !existing.purchased) {
      await tx.purchase.create({
        data: {
          householdId,
          userId,
          productName: item.name,
          url: item.url,
          source: 'shopping',
          estimatedPrice: item.estimatedPrice,
          lastPurchasedAt: item.purchasedAt,
        },
      });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: input.purchased ? 'completed' : 'reopened',
        subjectType: 'shopping_item',
        subjectId: item.id,
        message: input.purchased
          ? `bought “${item.name}”`
          : `un-checked “${item.name}”`,
      },
      tx,
    );

    return item;
  });
}

export async function deleteShoppingItem(
  householdId: string,
  userId: string,
  itemId: string,
): Promise<void> {
  const item = await findItemInHousehold(itemId, householdId);

  await prisma.shoppingItem.delete({ where: { id: itemId } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'shopping_item',
    subjectId: itemId,
    message: `removed “${item.name}” from the list`,
  });
}

/**
 * Clear purchased items from a list. Non-recurring items are deleted; recurring
 * consumables (e.g. paper towels) are un-checked so they stay on the list for
 * the next shopping trip.
 */
export async function clearPurchased(
  householdId: string,
  userId: string,
  listId: string,
): Promise<ShoppingListWithItems> {
  const list = await assertListInHousehold(listId, householdId);

  return prisma.$transaction(async (tx) => {
    const purchased = await tx.shoppingItem.findMany({
      where: { listId, purchased: true },
      select: { id: true, recurring: true },
    });

    const toDelete = purchased.filter((i) => !i.recurring).map((i) => i.id);
    const toReset = purchased.filter((i) => i.recurring).map((i) => i.id);

    if (toDelete.length > 0) {
      await tx.shoppingItem.deleteMany({ where: { id: { in: toDelete } } });
    }
    if (toReset.length > 0) {
      await tx.shoppingItem.updateMany({
        where: { id: { in: toReset } },
        data: { purchased: false, purchasedAt: null },
      });
    }

    if (purchased.length > 0) {
      await logActivity(
        {
          householdId,
          actorId: userId,
          verb: 'updated',
          subjectType: 'shopping_list',
          subjectId: list.id,
          message: `cleared ${purchased.length} purchased item${
            purchased.length === 1 ? '' : 's'
          } from ${list.name}`,
          metadata: { deleted: toDelete.length, reset: toReset.length },
        },
        tx,
      );
    }

    return tx.shoppingList.findUniqueOrThrow({
      where: { id: listId },
      include: listInclude,
    });
  });
}

async function assertListInHousehold(
  listId: string,
  householdId: string,
  db: Db = prisma,
) {
  const list = await db.shoppingList.findFirst({
    where: { id: listId, householdId },
  });
  if (!list) throw new NotFoundError(`Shopping list ${listId} not found.`);
  return list;
}

async function findItemInHousehold(
  itemId: string,
  householdId: string,
  db: Db = prisma,
) {
  const item = await db.shoppingItem.findFirst({
    where: { id: itemId, list: { householdId } },
    include: itemInclude,
  });
  if (!item) throw new NotFoundError(`Shopping item ${itemId} not found.`);
  return item;
}
