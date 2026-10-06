import { prisma } from '@/server/db/prisma';
import type { InventoryItemDTO, NfcScanDTO } from '@/lib/types';
import type { NfcScanWebhookInput } from '@/lib/validation/events';
import {
  adjustQuantity,
  createInventoryItem,
  itemToDTO,
} from '@/server/services/inventoryService';
import { parseTagItemId, registerNfcTag } from '@/server/services/nfcService';
import { NotFoundError } from '@/server/services/errors';

/**
 * Ingest an NFC scan from Home Assistant: resolve the tag → bound inventory
 * item, apply the signed amount, and record the raw event for auditing. If the
 * scan carries an `actor` (app username, mapped per phone in HA), it is resolved
 * to a household member so the activity feed names them; otherwise the entry is
 * logged with a null actor and shows as "System".
 *
 * The first scan of an unknown tag auto-registers a new inventory item and binds
 * the tag, provided the scan carries a non-empty `name` (the HA tag's friendly
 * name). A nameless unknown tag still 404s, so a stray scan can't create junk.
 */
export async function ingestNfcScan(
  householdId: string,
  input: NfcScanWebhookInput,
  // The Android app scans as the signed-in user (source "nfc"); the HA webhook
  // leaves this unset and identifies the scanner by `input.actor`.
  opts: { actorId?: string; source?: 'home_assistant' | 'nfc' } = {},
): Promise<InventoryItemDTO> {
  const source = opts.source ?? 'home_assistant';
  const tag = await prisma.nfcTag.findUnique({
    where: { householdId_tagId: { householdId, tagId: input.tagId } },
  });

  // Resolve the scanning user to a member of THIS household. An unknown or
  // missing username falls back to System rather than failing the scan.
  let actorId: string | null = opts.actorId ?? null;
  if (!actorId && input.actor) {
    const member = await prisma.user.findFirst({
      where: { householdId, username: input.actor.toLowerCase() },
      select: { id: true },
    });
    actorId = member?.id ?? null;
  }

  // Unknown tag: auto-register a new item + binding when we have a name to use.
  if (!tag) {
    const name = input.name?.trim();
    if (!name) {
      throw new NotFoundError(`No NFC tag registered for “${input.tagId}”.`);
    }
    return autoRegisterFromScan(householdId, actorId, name, input, source);
  }

  const itemId = parseTagItemId(tag);
  if (!itemId) {
    throw new NotFoundError(`Tag “${tag.tagId}” is not bound to an item.`);
  }

  const item = await adjustQuantity(householdId, actorId, itemId, input.amount, {
    note: input.note,
    source,
  });

  await prisma.eventLog.create({
    data: {
      householdId,
      eventType: 'nfc_scan',
      source,
      payload: JSON.stringify({
        ...input,
        itemId,
        actorId,
        resultQuantity: item.quantity,
      }),
      processedAt: new Date(),
    },
  });

  return itemToDTO(item);
}

/**
 * First scan of an unknown tag: create the inventory item named after the HA
 * tag, seed its quantity from the scanned amount (clamped at 0), and bind the
 * tag to it. The raw scan is recorded as an `nfc_register` event for auditing.
 */
async function autoRegisterFromScan(
  householdId: string,
  actorId: string | null,
  name: string,
  input: NfcScanWebhookInput,
  source: 'home_assistant' | 'nfc',
): Promise<InventoryItemDTO> {
  const created = await createInventoryItem(householdId, actorId, {
    name,
    unit: null,
    quantity: Math.max(0, input.amount),
    lowThreshold: 0,
    reorderIntervalDays: null,
    categoryId: null,
  });

  await registerNfcTag(householdId, actorId, {
    tagId: input.tagId,
    label: name,
    itemId: created.id,
    represents: 'consumable',
  });

  await prisma.eventLog.create({
    data: {
      householdId,
      eventType: 'nfc_register',
      source,
      payload: JSON.stringify({
        ...input,
        itemId: created.id,
        actorId,
        resultQuantity: created.quantity,
      }),
      processedAt: new Date(),
    },
  });

  return itemToDTO(created);
}

/**
 * Recent tag scans and setups, newest first, from either Home Assistant or the
 * Android app — "what was scanned, when, by whom". Item and actor names are
 * resolved in two queries; a deleted item/member just shows as null.
 */
export async function listRecentScans(householdId: string, limit = 30): Promise<NfcScanDTO[]> {
  const rows = await prisma.eventLog.findMany({
    where: { householdId, eventType: { in: ['nfc_scan', 'nfc_register'] } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const parsed = rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      // Malformed legacy payloads still list, just without details.
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    return {
      row,
      tagId: str(payload.tagId) ?? '',
      itemId: str(payload.itemId),
      actorId: str(payload.actorId),
      amount: num(payload.amount),
      resultQuantity: num(payload.resultQuantity),
    };
  });

  const itemIds = [...new Set(parsed.map((p) => p.itemId).filter((v): v is string => v !== null))];
  const actorIds = [...new Set(parsed.map((p) => p.actorId).filter((v): v is string => v !== null))];
  const [items, actors] = await Promise.all([
    itemIds.length
      ? prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } })
      : [],
    actorIds.length
      ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const itemNames = new Map(items.map((i) => [i.id, i.name]));
  const actorNames = new Map(actors.map((a) => [a.id, a.name]));

  return parsed.map((p) => ({
    id: p.row.id,
    kind: p.row.eventType === 'nfc_register' ? 'register' : 'scan',
    tagId: p.tagId,
    itemId: p.itemId,
    itemName: p.itemId ? (itemNames.get(p.itemId) ?? null) : null,
    amount: p.amount,
    resultQuantity: p.resultQuantity,
    source: p.row.source,
    actorName: p.actorId ? (actorNames.get(p.actorId) ?? null) : null,
    createdAt: p.row.createdAt.toISOString(),
  }));
}
