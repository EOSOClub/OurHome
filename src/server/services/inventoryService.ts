import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { CategoryDTO, InventoryItemDTO } from '@/lib/types';
import type {
  CreateInventoryCategoryInput,
  CreateInventoryItemInput,
  UpdateInventoryItemInput,
} from '@/lib/validation/inventory';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, NotFoundError } from '@/server/services/errors';

type Db = typeof prisma | Prisma.TransactionClient;

const itemInclude = {
  category: { select: { id: true, name: true, color: true } },
} satisfies Prisma.InventoryItemInclude;

export type InventoryItemWithRelations = Prisma.InventoryItemGetPayload<{
  include: typeof itemInclude;
}>;

/** A stock level is "low" only when a threshold is set and we're at/below it. */
function computeIsLow(quantity: number, lowThreshold: number): boolean {
  return lowThreshold > 0 && quantity <= lowThreshold;
}

/**
 * Predict when an item will run out, for the reminder engine's reorder branch
 * (reminderService flags items whose `predictedDepletionAt` falls within its
 * look-ahead window).
 *
 * Heuristic: `reorderIntervalDays` means "we restock this roughly every N
 * days", so the stock on hand is expected to last N days from the most recent
 * restock — `lastRestockedAt + N days`, falling back to `from` (now) when the
 * item has never been restocked. Refreshed on every restock (positive
 * adjustment) and whenever the interval changes; returns null when no interval
 * is configured. Pure so it's trivially unit-testable.
 */
function computePredictedDepletionAt(
  reorderIntervalDays: number | null,
  lastRestockedAt: Date | null,
  from: Date = new Date(),
): Date | null {
  if (reorderIntervalDays === null || reorderIntervalDays <= 0) return null;
  const base = lastRestockedAt ?? from;
  return new Date(base.getTime() + reorderIntervalDays * 86_400_000);
}

/** Map a Prisma inventory item (with relations) to the serializable client DTO. */
export function itemToDTO(item: InventoryItemWithRelations): InventoryItemDTO {
  return {
    id: item.id,
    name: item.name,
    unit: item.unit,
    quantity: item.quantity,
    lowThreshold: item.lowThreshold,
    isLow: item.isLow,
    reorderIntervalDays: item.reorderIntervalDays,
    lastRestockedAt: item.lastRestockedAt?.toISOString() ?? null,
    predictedDepletionAt: item.predictedDepletionAt?.toISOString() ?? null,
    category: item.category
      ? { id: item.category.id, name: item.category.name, color: item.category.color }
      : null,
  };
}

/** Inventory categories for a household, alphabetical. */
export async function listInventoryCategories(
  householdId: string,
): Promise<CategoryDTO[]> {
  return prisma.category.findMany({
    where: { householdId, kind: 'inventory' },
    select: { id: true, name: true, color: true },
    orderBy: { name: 'asc' },
  });
}

export async function createInventoryCategory(
  householdId: string,
  userId: string,
  input: CreateInventoryCategoryInput,
): Promise<CategoryDTO> {
  let category: CategoryDTO;
  try {
    category = await prisma.category.create({
      data: {
        householdId,
        kind: 'inventory',
        name: input.name,
        color: input.color ?? null,
      },
      select: { id: true, name: true, color: true },
    });
  } catch (err) {
    // Unique [householdId, name, kind]: a category by this name already exists.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ConflictError(
        `A category named “${input.name}” already exists.`,
      );
    }
    throw err;
  }

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'category',
    subjectId: category.id,
    message: `added inventory category “${category.name}”`,
  });

  return category;
}

/**
 * Delete an inventory category. Items in this category keep their data; their
 * `categoryId` is set to null by the schema's onDelete: SetNull relation.
 */
export async function deleteInventoryCategory(
  householdId: string,
  userId: string,
  categoryId: string,
): Promise<void> {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, householdId, kind: 'inventory' },
    select: { id: true, name: true },
  });
  if (!category) {
    throw new NotFoundError(`Category ${categoryId} not found.`);
  }

  await prisma.category.delete({ where: { id: categoryId } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'category',
    subjectId: categoryId,
    message: `removed inventory category “${category.name}”`,
  });
}

export async function listInventoryItems(
  householdId: string,
): Promise<InventoryItemWithRelations[]> {
  return prisma.inventoryItem.findMany({
    where: { householdId },
    include: itemInclude,
    // Low-stock items first, then alphabetical.
    orderBy: [{ isLow: 'desc' }, { name: 'asc' }],
  });
}

export async function createInventoryItem(
  householdId: string,
  userId: string | null,
  input: CreateInventoryItemInput,
): Promise<InventoryItemWithRelations> {
  const item = await prisma.inventoryItem.create({
    data: {
      householdId,
      name: input.name,
      unit: input.unit ?? null,
      quantity: input.quantity,
      lowThreshold: input.lowThreshold,
      isLow: computeIsLow(input.quantity, input.lowThreshold),
      reorderIntervalDays: input.reorderIntervalDays ?? null,
      // A brand-new item has no restock history; forecast from now.
      predictedDepletionAt: computePredictedDepletionAt(
        input.reorderIntervalDays ?? null,
        null,
      ),
      categoryId: input.categoryId ?? null,
    },
    include: itemInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'inventory_item',
    subjectId: item.id,
    message: `added “${item.name}” to inventory`,
  });

  return item;
}

export async function updateInventoryItem(
  householdId: string,
  userId: string,
  input: UpdateInventoryItemInput,
): Promise<InventoryItemWithRelations> {
  const { itemId, ...rest } = input;
  const existing = await findItemInHousehold(itemId, householdId);

  // Recompute the low flag against whichever of quantity/threshold changed.
  const nextQuantity = rest.quantity ?? existing.quantity;
  const nextThreshold = rest.lowThreshold ?? existing.lowThreshold;

  // A changed reorder interval invalidates the depletion forecast; recompute
  // it from the existing restock history. (Restocks themselves refresh the
  // forecast in adjustQuantity, the actual restock path.)
  const intervalProvided = rest.reorderIntervalDays !== undefined;
  const intervalChanged =
    intervalProvided && rest.reorderIntervalDays !== existing.reorderIntervalDays;

  const item = await prisma.inventoryItem.update({
    where: { id: itemId },
    data: {
      name: rest.name,
      unit: rest.unit,
      quantity: rest.quantity,
      lowThreshold: rest.lowThreshold,
      isLow: computeIsLow(nextQuantity, nextThreshold),
      reorderIntervalDays: rest.reorderIntervalDays,
      ...(intervalChanged
        ? {
            predictedDepletionAt: computePredictedDepletionAt(
              rest.reorderIntervalDays ?? null,
              existing.lastRestockedAt,
            ),
          }
        : {}),
      categoryId: rest.categoryId,
    },
    include: itemInclude,
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'inventory_item',
    subjectId: item.id,
    message: `updated “${item.name}”`,
  });

  return item;
}

export interface AdjustOptions {
  note?: string | null;
  /** Where the change came from, e.g. "web" or "home_assistant". */
  source?: string;
}

/**
 * Apply a signed delta to an item's quantity. Negative removes stock, positive
 * restocks; the result is clamped at 0. Recomputes the low-stock flag and logs
 * the change to the activity feed. `actorId` may be null for automated scans.
 */
export async function adjustQuantity(
  householdId: string,
  actorId: string | null,
  itemId: string,
  delta: number,
  opts: AdjustOptions = {},
  db: Db = prisma,
): Promise<InventoryItemWithRelations> {
  const existing = await findItemInHousehold(itemId, householdId, db);

  const newQuantity = Math.max(0, existing.quantity + delta);
  const wasLow = existing.isLow;
  const isLow = computeIsLow(newQuantity, existing.lowThreshold);

  // A positive adjustment counts as a restock, which also resets the
  // depletion forecast: full again, expected to last one reorder interval.
  const restockedAt = delta > 0 ? new Date() : existing.lastRestockedAt;

  const item = await db.inventoryItem.update({
    where: { id: itemId },
    data: {
      quantity: newQuantity,
      isLow,
      lastRestockedAt: restockedAt,
      ...(delta > 0
        ? {
            predictedDepletionAt: computePredictedDepletionAt(
              existing.reorderIntervalDays,
              restockedAt,
            ),
          }
        : {}),
    },
    include: itemInclude,
  });

  const verb = delta > 0 ? 'restocked' : 'consumed';
  const unit = item.unit ? ` ${item.unit}` : '';
  await logActivity(
    {
      householdId,
      actorId,
      verb,
      subjectType: 'inventory_item',
      subjectId: item.id,
      message: `${verb} ${Math.abs(delta)}${unit} of “${item.name}” (now ${newQuantity})`,
      metadata: {
        delta,
        quantity: newQuantity,
        source: opts.source ?? 'web',
        note: opts.note ?? undefined,
      },
    },
    db,
  );

  // Note the moment a stock level newly drops into "low".
  if (isLow && !wasLow) {
    await logActivity(
      {
        householdId,
        actorId,
        verb: 'marked_low',
        subjectType: 'inventory_item',
        subjectId: item.id,
        message: `“${item.name}” is low (${newQuantity} left)`,
      },
      db,
    );
  }

  return item;
}

export async function deleteInventoryItem(
  householdId: string,
  userId: string,
  itemId: string,
): Promise<void> {
  const item = await findItemInHousehold(itemId, householdId);

  await prisma.inventoryItem.delete({ where: { id: itemId } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'inventory_item',
    subjectId: itemId,
    message: `removed “${item.name}” from inventory`,
  });
}

export async function findItemInHousehold(
  itemId: string,
  householdId: string,
  db: Db = prisma,
): Promise<InventoryItemWithRelations> {
  const item = await db.inventoryItem.findFirst({
    where: { id: itemId, householdId },
    include: itemInclude,
  });
  if (!item) throw new NotFoundError(`Inventory item ${itemId} not found.`);
  return item;
}
