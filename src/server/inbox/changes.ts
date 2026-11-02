import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { InboxError, type InboxClient, type InboxChangeReport } from '@/server/inbox/client';

// Telling OurHomeInbox what people did here to the bills it sent (contract
// v2, docs/ourhomeinbox-import.md): `paid` when a payment recorded by hand
// leaves such a bill fully paid (on a recurring bill any hand payment, since
// it closes the cycle), `removed` when a person deletes one. That way
// OurHomeInbox never pairs a later payment email with a bill already settled
// or gone here. A bill made from a "Paid on its own" receipt carries that
// receipt's Message-ID, so its reports name a payment email; OurHomeInbox
// ignores those.
//
// Changes are queued (InboxChange) in the same transaction as what caused
// them, only while an OurHomeInbox is connected, and sent at the start of
// every import run (sync.ts), 100 at a time, until OurHomeInbox accepts them
// with a 200. Sending the same change twice is harmless there, so a run that
// fails half way just sends again next time. Rows are kept after sending and
// survive a disconnect: a "removed" one keeps that bill from coming back.

export type InboxChangeKind = InboxChangeReport['change'];

type Db = Prisma.TransactionClient | typeof prisma;

/** Changes per request (the contract allows 1 to 100). */
export const CHANGES_PER_REQUEST = 100;
/** Requests per run, so a long queue goes out over a few runs instead of one long one. */
const MAX_REQUESTS = 20;
/** Changes refused one by one in a row before the send stops without setting any aside. */
export const REFUSALS_IN_A_ROW = 3;

/**
 * A bill imported from OurHomeInbox: the OurHomeInbox import writes
 * source "email" and keeps the email's Message-ID as `sourceMessageId`, the
 * key the contract's `messageId` means. (Paperless bills are "paperless";
 * bills made by hand are "manual" and have no Message-ID.)
 */
export function isInboxBill(bill: { source: string; sourceMessageId: string | null }): bill is { source: 'email'; sourceMessageId: string } {
  return bill.source === 'email' && !!bill.sourceMessageId;
}

/**
 * Queue a change to a bill for OurHomeInbox, inside the caller's transaction.
 * Does nothing for a bill that didn't come from OurHomeInbox, or when the
 * household has no OurHomeInbox connected (nothing would ever send it).
 * Returns whether it queued one.
 */
export async function queueInboxChange(
  db: Db,
  householdId: string,
  bill: { source: string; sourceMessageId: string | null },
  change: InboxChangeKind,
  at: Date = new Date(),
): Promise<boolean> {
  if (!isInboxBill(bill)) return false;
  if ((await db.inboxConnection.count({ where: { householdId } })) === 0) return false;
  await db.inboxChange.create({
    data: { householdId, messageId: bill.sourceMessageId, change, at, sentAt: null },
  });
  return true;
}

/**
 * True when a person here deleted the bill this email made (a "removed"
 * change, sent or not). Such an email doesn't make its bill again when
 * OurHomeInbox offers it again (a value fixed there, or the feed starting
 * over after a reconnect): removed bills stay removed (contract v2).
 */
export async function removedHere(householdId: string, messageId: string): Promise<boolean> {
  return (await prisma.inboxChange.count({ where: { householdId, messageId, change: 'removed' } })) > 0;
}

export interface SendChangesResult {
  /** Changes OurHomeInbox accepted this run. */
  sent: number;
  /** Changes OurHomeInbox refused one by one (a 400): marked done, never sent again. */
  rejected: number;
  /** Why the rest are still queued, in plain words; null when all went. */
  error: string | null;
}

/** Shown when the failure is on this side (reading or marking the queue), not OurHomeInbox's. */
export const QUEUE_UNREADABLE = 'Couldn’t read the list of changes to send.';

type Queued = { id: string; messageId: string; change: string; at: Date };

const report = (c: Queued): InboxChangeReport => ({
  messageId: c.messageId,
  change: c.change as InboxChangeKind,
  at: c.at.toISOString(),
});

const refused = (err: unknown): err is InboxError => err instanceof InboxError && err.status === 400;

/**
 * Send the household's queued changes. Never throws: a failure keeps the
 * changes queued for the next run and comes back as `error`, so the import
 * after it still runs.
 *
 * OurHomeInbox refuses a whole request (400, nothing kept) when one change in
 * it breaks the rules. So a refused batch is sent again one change at a time:
 * the good ones go, and one refused on its own is marked done with the reason
 * (`rejected`), so a single bad change never holds up the queue. Three
 * refused in a row stop that: nothing is marked and the rest wait, so a
 * mismatch between the two sides can't throw the whole queue away.
 */
export async function sendInboxChanges(householdId: string, client: InboxClient): Promise<SendChangesResult> {
  let sent = 0;
  let rejected = 0;
  const markSent = (ids: string[]) =>
    prisma.inboxChange.updateMany({ where: { id: { in: ids } }, data: { sentAt: new Date() } });
  try {
    const queued: Queued[] = await prisma.inboxChange.findMany({
      where: { householdId, OR: [{ sentAt: null }, { sentAt: { isSet: false } }] },
      orderBy: { at: 'asc' },
      take: CHANGES_PER_REQUEST * MAX_REQUESTS,
      select: { id: true, messageId: true, change: true, at: true },
    });
    for (let i = 0; i < queued.length; i += CHANGES_PER_REQUEST) {
      const batch = queued.slice(i, i + CHANGES_PER_REQUEST);
      try {
        await client.changes(batch.map(report));
      } catch (err) {
        if (!refused(err)) throw err;
        // One (or more) bad changes spoil the batch: one at a time instead.
        // Refusals are held until a change after them goes through (or the
        // batch ends): a run of REFUSALS_IN_A_ROW means OurHomeInbox refuses
        // everything (a contract mismatch after an upgrade, say), so none of
        // them is marked and the rest stay queued for a later run.
        let held: { change: Queued; reason: string }[] = [];
        const settleHeld = async () => {
          for (const { change, reason } of held) {
            await prisma.inboxChange.update({
              where: { id: change.id },
              data: { sentAt: new Date(), rejected: reason.slice(0, 300) },
            });
            console.warn(`[inbox] household ${householdId}: OurHomeInbox refused change ${change.id} (${change.change} ${change.messageId}): ${reason}`);
            rejected += 1;
          }
          held = [];
        };
        for (const change of batch) {
          try {
            await client.changes([report(change)]);
          } catch (single) {
            if (!refused(single)) throw single;
            held.push({ change, reason: single.message });
            if (held.length >= REFUSALS_IN_A_ROW) {
              throw new InboxError(
                `OurHomeInbox refused ${held.length} changes in a row, so none was set aside (${single.message.replace(/\.+$/, '')})`,
                400,
              );
            }
            continue;
          }
          await settleHeld();
          await markSent([change.id]);
          sent += 1;
        }
        await settleHeld();
        continue;
      }
      // Only reached on a 200 (the client throws otherwise).
      await markSent(batch.map((c) => c.id));
      sent += batch.length;
    }
    return { sent, rejected, error: null };
  } catch (err) {
    if (err instanceof InboxError) return { sent, rejected, error: err.message };
    // Something on this side (the database); the details go to the log, not the card.
    console.warn(`[inbox] household ${householdId}: couldn't send changes:`, err instanceof Error ? err.message : err);
    return { sent, rejected, error: QUEUE_UNREADABLE };
  }
}
