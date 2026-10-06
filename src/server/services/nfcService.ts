import type { NfcTag } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { NfcLookupDTO, NfcTagDTO } from '@/lib/types';
import type { NfcScanAction } from '@/lib/enums';
import type {
  NfcSetupInput,
  NfcTagSettingsInput,
  RegisterNfcTagInput,
} from '@/lib/validation/nfc';
import { logActivity } from '@/server/services/activityService';
import { addShoppingItem } from '@/server/services/shoppingService';
import {
  createInventoryItem,
  findItemInHousehold,
  itemToDTO,
} from '@/server/services/inventoryService';
import { NotFoundError } from '@/server/services/errors';

/** Everything a tag stores as JSON text in `config`. */
export interface TagConfig {
  itemId?: string;
  /** Android app behaviour on scan; absent = "open". */
  scanAction?: NfcScanAction;
  /** Target of "Add to shopping list"; absent = first grocery list. */
  shoppingListId?: string | null;
}

export function parseTagConfig(tag: Pick<NfcTag, 'config'> | null): TagConfig {
  if (!tag?.config) return {};
  try {
    const parsed = JSON.parse(tag.config) as Record<string, unknown>;
    return {
      itemId: typeof parsed.itemId === 'string' ? parsed.itemId : undefined,
      scanAction: parsed.scanAction === 'notify' ? 'notify' : parsed.scanAction === 'open' ? 'open' : undefined,
      shoppingListId: typeof parsed.shoppingListId === 'string' ? parsed.shoppingListId : null,
    };
  } catch {
    return {};
  }
}

/** The tag's bound inventory item id. */
export function parseTagItemId(tag: Pick<NfcTag, 'config'>): string | null {
  return parseTagConfig(tag).itemId ?? null;
}

export async function listNfcTags(householdId: string): Promise<NfcTagDTO[]> {
  const tags = await prisma.nfcTag.findMany({
    where: { householdId },
    orderBy: { label: 'asc' },
  });

  // Resolve bound item names in one query rather than per tag.
  const itemIds = tags
    .map(parseTagItemId)
    .filter((id): id is string => id !== null);
  const items = itemIds.length
    ? await prisma.inventoryItem.findMany({
        where: { householdId, id: { in: itemIds } },
        select: { id: true, name: true },
      })
    : [];
  const itemsById = new Map(items.map((i) => [i.id, i]));

  return tags.map((tag) => tagToDTO(tag, itemsById));
}

function tagToDTO(
  tag: NfcTag,
  itemsById: Map<string, { id: string; name: string }>,
): NfcTagDTO {
  const config = parseTagConfig(tag);
  const item = config.itemId ? (itemsById.get(config.itemId) ?? null) : null;
  return {
    id: tag.id,
    tagId: tag.tagId,
    label: tag.label,
    represents: tag.represents,
    item,
    scanAction: config.scanAction ?? 'open',
    shoppingListId: config.shoppingListId ?? null,
  };
}

async function assertShoppingList(householdId: string, listId: string | null | undefined) {
  if (!listId) return;
  const list = await prisma.shoppingList.findFirst({ where: { id: listId, householdId }, select: { id: true } });
  if (!list) throw new NotFoundError('That shopping list is not in this household.');
}

export async function registerNfcTag(
  householdId: string,
  userId: string | null,
  input: RegisterNfcTagInput,
): Promise<NfcTagDTO> {
  // Only allow binding to an item that exists in this household.
  const item = await findItemInHousehold(input.itemId, householdId);
  await assertShoppingList(householdId, input.shoppingListId);
  // Re-binding keeps the tag's app settings unless new ones are given.
  const existing = await prisma.nfcTag.findUnique({
    where: { householdId_tagId: { householdId, tagId: input.tagId } },
    select: { config: true },
  });
  const config = JSON.stringify({
    ...parseTagConfig(existing),
    itemId: item.id,
    ...(input.scanAction ? { scanAction: input.scanAction } : {}),
    ...(input.shoppingListId !== undefined ? { shoppingListId: input.shoppingListId } : {}),
  } satisfies TagConfig);

  const tag = await prisma.nfcTag.upsert({
    where: { householdId_tagId: { householdId, tagId: input.tagId } },
    update: { label: input.label, represents: input.represents, config },
    create: {
      householdId,
      tagId: input.tagId,
      label: input.label,
      represents: input.represents,
      config,
    },
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'updated',
    subjectType: 'nfc_tag',
    subjectId: tag.id,
    message: `mapped tag “${tag.label}” to “${item.name}”`,
  });

  return tagToDTO(tag, new Map([[item.id, item]]));
}

/**
 * What a scanned tag resolves to, for the Android app: the tag (or null if it
 * isn't set up yet) and its bound item. Read-only — nothing is recorded.
 */
export async function lookupNfcTag(householdId: string, tagId: string): Promise<NfcLookupDTO> {
  const tag = await prisma.nfcTag.findUnique({
    where: { householdId_tagId: { householdId, tagId } },
  });
  if (!tag) return { tagId, tag: null, item: null };

  const itemId = parseTagItemId(tag);
  // A tag bound to a since-deleted item resolves to no item (the app offers re-binding).
  const item = itemId ? await findItemInHousehold(itemId, householdId).catch(() => null) : null;
  return {
    tagId,
    tag: tagToDTO(tag, new Map(item ? [[item.id, { id: item.id, name: item.name }]] : [])),
    item: item ? itemToDTO(item) : null,
  };
}

/**
 * Set up a tag from the Android app in one step: bind it to an existing item,
 * or create the item first. Re-running it re-binds the tag (the upsert in
 * registerNfcTag). Recorded as an `nfc_register` event for the scan history.
 */
export async function setupNfcTag(
  householdId: string,
  userId: string,
  input: NfcSetupInput,
): Promise<NfcLookupDTO> {
  const item = input.newItem
    ? await createInventoryItem(householdId, userId, {
        name: input.newItem.name,
        unit: input.newItem.unit ?? null,
        quantity: input.newItem.quantity,
        lowThreshold: input.newItem.lowThreshold,
        reorderIntervalDays: null,
        categoryId: null,
      })
    : await findItemInHousehold(input.itemId!, householdId);

  await registerNfcTag(householdId, userId, {
    tagId: input.tagId,
    label: input.label ?? item.name,
    itemId: item.id,
    represents: 'consumable',
    scanAction: input.scanAction,
    shoppingListId: input.shoppingListId,
  });

  await prisma.eventLog.create({
    data: {
      householdId,
      eventType: 'nfc_register',
      source: 'nfc',
      payload: JSON.stringify({
        tagId: input.tagId,
        itemId: item.id,
        actorId: userId,
        createdItem: Boolean(input.newItem),
        resultQuantity: item.quantity,
      }),
      processedAt: new Date(),
    },
  });

  return lookupNfcTag(householdId, input.tagId);
}

/** Change how the Android app treats a scan of [input.tagId]. */
export async function updateTagSettings(
  householdId: string,
  input: NfcTagSettingsInput,
): Promise<NfcLookupDTO> {
  const tag = await prisma.nfcTag.findUnique({
    where: { householdId_tagId: { householdId, tagId: input.tagId } },
  });
  if (!tag) throw new NotFoundError(`No NFC tag registered for “${input.tagId}”.`);
  await assertShoppingList(householdId, input.shoppingListId);
  const config: TagConfig = {
    ...parseTagConfig(tag),
    scanAction: input.scanAction,
    ...(input.shoppingListId !== undefined ? { shoppingListId: input.shoppingListId } : {}),
  };
  await prisma.nfcTag.update({ where: { id: tag.id }, data: { config: JSON.stringify(config) } });
  return lookupNfcTag(householdId, input.tagId);
}

/**
 * "Add to shopping list" from a quick-scan notification: put the tag's item on
 * its configured list (else the first grocery list, else the first list). If
 * an unbought item of the same name is already there, nothing is added.
 */
export async function addTagItemToShopping(
  householdId: string,
  userId: string,
  tagId: string,
): Promise<{ itemName: string; listName: string; added: boolean }> {
  const tag = await prisma.nfcTag.findUnique({ where: { householdId_tagId: { householdId, tagId } } });
  const config = parseTagConfig(tag);
  if (!config.itemId) throw new NotFoundError(`Tag “${tagId}” is not bound to an item.`);
  const item = await findItemInHousehold(config.itemId, householdId);

  const lists = await prisma.shoppingList.findMany({
    where: { householdId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, kind: true },
  });
  const list =
    lists.find((l) => l.id === config.shoppingListId) ??
    lists.find((l) => l.kind === 'grocery') ??
    lists[0];
  if (!list) throw new NotFoundError('There are no shopping lists yet.');

  const existing = await prisma.shoppingItem.findFirst({
    where: { listId: list.id, purchased: false, name: { equals: item.name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!existing) {
    await addShoppingItem(householdId, userId, {
      listId: list.id,
      name: item.name,
      quantity: 1,
      priority: 'medium',
      recurring: false,
    });
  }
  return { itemName: item.name, listName: list.name, added: !existing };
}

export async function deleteNfcTag(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const tag = await prisma.nfcTag.findFirst({ where: { id, householdId } });
  if (!tag) throw new NotFoundError(`NFC tag ${id} not found.`);

  await prisma.nfcTag.delete({ where: { id } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'nfc_tag',
    subjectId: id,
    message: `removed tag “${tag.label}”`,
  });
}
