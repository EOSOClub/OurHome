import { isFeatureEnabled, isHouseholdDisabled } from '@/server/services/serverAdminService';
import { ConflictError } from '@/server/services/errors';
import { decryptSecret, encryptSecret } from '@/server/security/secrets';
import { prisma } from '@/server/db/prisma';
import { InboxClient, type InboxConfig } from '@/server/inbox/client';
import { helloSchema, parseDocumentsReply, type InboxEntry, type InboxHello } from '@/server/inbox/mapping';
import { ingestFinancialDoc } from '@/server/billIngest/ingest';
import { withdrawEmailDoc } from '@/server/inbox/withdraw';
import { removedHere, sendInboxChanges } from '@/server/inbox/changes';
import { hasPaperless, paperlessMayUsePrivateNetwork } from '@/server/services/paperlessSync';
import { getPointsSettings } from '@/server/services/pointsService';
import { syncFailureMessage } from '@/server/api/syncError';
import type { InboxOutcome, InboxStatusDTO, InboxSyncResultDTO } from '@/lib/types';

// Imports bills and bill payments from OurHomeInbox, the email bill reader
// that replaces the Paperless email import.
//
// Each run asks OurHomeInbox for the documents after the last number OurHome
// handled, hands each ready one to the bill importer (billIngest/), and takes back the bill
// a withdrawn one made. Runs from the in-app reminder sweep (every 15 minutes)
// and from Settings → "Check now". Asking with `after=n` is OurHomeInbox's
// only way of knowing OurHome has handled up to n. The only thing OurHome
// sends it is the change reports at the start of each run (changes.ts). The
// contract is in docs/ourhomeinbox-import.md.
//
//  - Starts fresh: OurHomeInbox leaves out emails captured before the start
//    date set with its token, so the first ask (after=0) brings only new ones.
//  - OurHomeInbox decides which emails are ready (a person checked it, or its
//    biller sends automatically); OurHome imports what it is given.
//  - OurHomeInbox also decides which bill each payment pays (contract v2): a
//    payment is linked only by the `reference` it sends, with its fee as
//    sent. One whose bill isn't here, or is already paid, is listed as
//    skipped; one with no reference ("Paid on its own") becomes a paid bill.
//  - An email offered again (a value fixed in OurHomeInbox) updates its bill
//    in place; a payment imports once.

/** How many skipped emails the status report remembers. */
const MAX_SKIPPED = 25;
/** Documents per ask (the contract allows 1 to 200). */
const PAGE = 100;
/** Pages per run, so a huge backlog comes in over a few sweeps instead of one long one. */
const MAX_PAGES = 20;

function parseResult(text: string | null): InboxSyncResultDTO | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as InboxSyncResultDTO;
  } catch {
    return null;
  }
}

/** The connection a household imports from, or null when it has none. */
async function connectionFor(householdId: string): Promise<InboxConfig | null> {
  const saved = await prisma.inboxConnection.findUnique({ where: { householdId } });
  if (!saved) return null;
  const token = decryptSecret(saved.tokenEnc);
  if (!token) {
    throw new Error('The saved OurHomeInbox token can’t be read (the server’s secret changed). Enter the token again in Settings.');
  }
  // The same trust as Paperless: the server admin allows a household's bill imports on the server's network.
  const publicOnly = !(await paperlessMayUsePrivateNetwork(householdId));
  return { url: saved.url, token, publicUrl: saved.publicUrl, publicOnly };
}

async function hello(client: InboxClient): Promise<InboxHello> {
  const parsed = helloSchema.safeParse(await client.hello());
  if (!parsed.success) throw new Error('That address answered, but not like OurHomeInbox does. Check the address.');
  return parsed.data;
}

// --- Import runs -------------------------------------------------------------------

/** The card's message when the change reports didn't go (the import after them still ran). */
export function changesNotSent(reason: string): string {
  return `OurHomeInbox wasn’t told about bills paid or deleted here. It will be told on the next check. (${reason.replace(/\.+$/, '')}.)`;
}

// One run at a time per household: the 15-minute sweep and "Check now" can overlap.
const running = new Map<string, Promise<InboxSyncResultDTO | null>>();

/**
 * Import for one household, or (no id) for every active household with an
 * OurHomeInbox, each on its own so one household's problem doesn't stop the
 * rest. Returns the one household's result (null when it has none). Errors are
 * stored on the household's sync record; a single-household run re-throws.
 */
export async function runInboxSync(householdId?: string): Promise<InboxSyncResultDTO | null> {
  if (householdId) return runFor(householdId);
  const saved = await prisma.inboxConnection.findMany({ select: { householdId: true } });
  for (const { householdId: id } of saved) {
    // Turned-off households, and ones whose Bills the server admin turned off
    // (the import only makes bills), are left alone.
    if (await isHouseholdDisabled(id)) continue;
    if (!(await isFeatureEnabled(id, 'bills'))) continue;
    await runFor(id).catch((err) => {
      console.warn(`[inbox] import for household ${id} failed; retrying next sweep:`, err instanceof Error ? err.message : err);
    });
  }
  return null;
}

function runFor(householdId: string): Promise<InboxSyncResultDTO | null> {
  let run = running.get(householdId);
  if (!run) {
    run = syncOnce(householdId).finally(() => running.delete(householdId));
    running.set(householdId, run);
  }
  return run;
}

async function handle(
  householdId: string,
  entry: InboxEntry,
): Promise<{ outcome: InboxOutcome; skip?: { title: string; reason: string; url: string | null } }> {
  if (entry.status === 'withdrawn') {
    const out = await withdrawEmailDoc(householdId, entry.messageId);
    if (out.status === 'removed') return { outcome: 'removed' };
    if (out.status === 'kept') {
      const why = `${entry.reason || 'Withdrawn in OurHomeInbox.'} Kept here: ${out.reason}.`;
      // A link to the bill here, where a person decides.
      const url = out.billId ? `/bills/${out.billId}` : null;
      return { outcome: 'kept', skip: { title: out.billName ?? entry.captureId, reason: why, url } };
    }
    // It never made anything here (it was skipped before): nothing to take back.
    return { outcome: 'withdrawn' };
  }
  if (!entry.input) {
    return { outcome: 'skipped', skip: { title: entry.title, reason: entry.problem ?? 'unreadable', url: entry.url } };
  }
  // Removed bills stay removed (contract v2): the email whose bill a person
  // deleted here doesn't make it again when OurHomeInbox offers it again.
  if (await removedHere(householdId, entry.input.messageId)) {
    return { outcome: 'skipped', skip: { title: entry.title, reason: 'Someone deleted this bill here', url: entry.url } };
  }
  // OurHomeInbox pairs its payments with their bills itself (contract v2).
  const out = await ingestFinancialDoc(householdId, entry.input, { source: 'email', receiptPairing: 'reference' });
  if (out.status === 'skipped') {
    return { outcome: 'skipped', skip: { title: entry.title, reason: out.reason ?? 'skipped', url: entry.url } };
  }
  return { outcome: out.status };
}

/** What the Settings card says after a failure that isn't for its reader (the log has it). */
const STORED_FAILURE = 'OurHomeInbox import failed. The server log has the details.';

async function syncOnce(householdId: string): Promise<InboxSyncResultDTO | null> {
  const cfg = await connectionFor(householdId).catch(async (err: unknown) => {
    // A connection that can't be used (unreadable token) is shown on the card,
    // in plain words: never a raw database error (syncFailureMessage).
    const message = syncFailureMessage(err, STORED_FAILURE, 'inbox');
    await prisma.inboxSync.updateMany({ where: { householdId }, data: { lastRunAt: new Date(), lastError: message } });
    throw err;
  });
  if (!cfg) return null;
  const now = new Date();

  const state =
    (await prisma.inboxSync.findUnique({ where: { householdId } })) ??
    (await prisma.inboxSync.create({ data: { householdId, after: 0 } }));
  const previous = parseResult(state.lastResult);
  const result: InboxSyncResultDTO = { checked: 0, imported: {}, skipped: previous?.skipped ?? [] };
  let after = state.after;

  try {
    const client = new InboxClient(cfg);
    // First what people did here to its bills (contract v2), so OurHomeInbox
    // knows before it pairs anything else. A failure keeps them queued for the
    // next run, is shown on the card, and doesn't stop the import.
    const report = await sendInboxChanges(householdId, client);
    // Plain days (due, paid) become noon in the household's zone, not the server's.
    const { timezone } = await getPointsSettings(householdId);
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = parseDocumentsReply(await client.documents(after, PAGE), after, cfg.publicUrl, timezone);
      result.checked += reply.entries.length;
      for (const entry of reply.entries) {
        const { outcome, skip } = await handle(householdId, entry);
        result.imported[outcome] = (result.imported[outcome] ?? 0) + 1;
        // An email seen again replaces its old skipped entry either way.
        result.skipped = result.skipped.filter((s) => s.id !== entry.captureId);
        if (skip) result.skipped.unshift({ id: entry.captureId, ...skip });
      }
      // Only once every document in the reply is handled (contract): if one
      // throws, the next run asks for the same ones again, and handling one
      // twice changes nothing.
      after = reply.next;
      await prisma.inboxSync.update({ where: { householdId }, data: { after } });
      // `more` with nothing sent would ask the same question forever.
      if (!reply.more || reply.entries.length === 0) break;
    }
    result.skipped = result.skipped.slice(0, MAX_SKIPPED);
    const lastError = report.error ? changesNotSent(report.error) : null;
    await prisma.inboxSync.update({
      where: { householdId },
      data: { after, lastRunAt: now, lastResult: JSON.stringify(result), lastError },
    });
    const counts = Object.entries(result.imported).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new';
    console.log(`[inbox] household ${householdId}: ${result.checked} document(s) from OurHomeInbox: ${counts}`);
    if (report.sent || report.rejected || report.error) {
      console.log(
        `[inbox] household ${householdId}: ${report.sent} change(s) reported to OurHomeInbox` +
          `${report.rejected ? `, ${report.rejected} refused by it` : ''}${report.error ? `; the rest wait: ${report.error}` : ''}`,
      );
    }
    return result;
  } catch (err) {
    const message = syncFailureMessage(err, STORED_FAILURE, 'inbox');
    result.skipped = result.skipped.slice(0, MAX_SKIPPED);
    await prisma.inboxSync.update({
      where: { householdId },
      data: { after, lastRunAt: now, lastResult: JSON.stringify(result), lastError: message },
    });
    throw err;
  }
}

// --- Status and the household's connection ------------------------------------------

export async function getInboxStatus(householdId: string, canEdit = false): Promise<InboxStatusDTO> {
  const [state, saved, privateOk, paperless] = await Promise.all([
    prisma.inboxSync.findUnique({ where: { householdId } }),
    prisma.inboxConnection.findUnique({
      where: { householdId },
      select: { url: true, publicUrl: true, remoteHousehold: true, createdAt: true },
    }),
    paperlessMayUsePrivateNetwork(householdId),
    hasPaperless(householdId).catch(() => false),
  ]);
  return {
    configured: saved !== null,
    connection: saved ? { url: saved.url, publicUrl: saved.publicUrl, remoteHousehold: saved.remoteHousehold } : null,
    canEdit,
    privateNetworkAllowed: privateOk,
    paperlessConnected: paperless,
    since: saved?.createdAt.toISOString() ?? null,
    handled: state?.after ?? 0,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    lastResult: parseResult(state?.lastResult ?? null),
  };
}

/** True when the household imports from an OurHomeInbox. */
export async function hasInbox(householdId: string): Promise<boolean> {
  return (await prisma.inboxConnection.count({ where: { householdId } })) > 0;
}

function cleanUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Save the household's OurHomeInbox (Head of House). The connection is tried
 * first (address allowed, token accepted, it answers like OurHomeInbox) and
 * nothing is saved if that fails. A blank token keeps the saved one. A
 * different address, or a token for a different OurHomeInbox household,
 * starts the import over from the beginning of that household's feed.
 */
export async function saveInboxConnection(
  householdId: string,
  input: { url: string; publicUrl?: string | null; token?: string | null },
): Promise<InboxStatusDTO> {
  const url = cleanUrl(input.url);
  const publicUrl = input.publicUrl ? cleanUrl(input.publicUrl) : null;
  const existing = await prisma.inboxConnection.findUnique({ where: { householdId } });
  let token = input.token?.trim() || null;
  if (!token && existing) token = decryptSecret(existing.tokenEnc);
  if (!token) throw new ConflictError('Paste the token you made in OurHomeInbox (Settings, OurHome connection).');

  const publicOnly = !(await paperlessMayUsePrivateNetwork(householdId));
  let found: InboxHello;
  try {
    found = await hello(new InboxClient({ url, token, publicUrl, publicOnly }));
  } catch (err) {
    throw new ConflictError(`Couldn’t use that OurHomeInbox: ${err instanceof Error ? err.message : String(err)}`);
  }

  const data = { url, publicUrl, tokenEnc: encryptSecret(token), remoteHousehold: found.household };
  const fresh = !existing || existing.url !== url || existing.remoteHousehold !== found.household;
  await prisma.$transaction(async (tx) => {
    await tx.inboxConnection.upsert({ where: { householdId }, create: { householdId, ...data }, update: data });
    if (fresh) await tx.inboxSync.deleteMany({ where: { householdId } });
  });
  return getInboxStatus(householdId, true);
}

/**
 * Forget the household's OurHomeInbox (and its import progress). Bills it
 * brought in stay, and so do its change reports (InboxChange): a reconnect
 * sends the unsent ones, and bills people deleted stay deleted.
 */
export async function removeInboxConnection(householdId: string): Promise<InboxStatusDTO> {
  await prisma.$transaction([
    prisma.inboxConnection.deleteMany({ where: { householdId } }),
    prisma.inboxSync.deleteMany({ where: { householdId } }),
  ]);
  return getInboxStatus(householdId, true);
}

/** Households that have an OurHomeInbox connected, for the Server page. */
export async function inboxHouseholds(): Promise<Set<string>> {
  const saved = await prisma.inboxConnection.findMany({ select: { householdId: true } });
  return new Set(saved.map((c) => c.householdId));
}
