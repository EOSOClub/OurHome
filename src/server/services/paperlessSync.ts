import { ensureServerAdmin, isFeatureEnabled, isHouseholdDisabled } from '@/server/services/serverAdminService';
import { ConflictError } from '@/server/services/errors';
import { decryptSecret, encryptSecret } from '@/server/security/secrets';
import { prisma } from '@/server/db/prisma';
import { PaperlessClient, paperlessConfig, type PaperlessConfig } from '@/server/paperless/client';
import {
  evaluateDocument,
  type DocKind,
  type Evaluation,
  type MappingContext,
  type PaperlessDocument,
} from '@/server/paperless/mapping';
import { paperlessNames } from '@/server/paperless/names';
import { ingestFinancialDoc } from '@/server/services/billIngestService';
import type { PaperlessStatusDTO, PaperlessSyncResultDTO } from '@/lib/types';

// Imports bills and bill payments from Paperless-ngx.
//
// Each run asks Paperless for documents tagged `bill` / `bill-payment` that
// changed since the last run (the stored cursor) and hands each finished one to
// billIngestService. Runs from the in-app reminder sweep (every 15 minutes)
// and from Settings → "Check now". Read-only towards Paperless. Each household
// has its own Paperless, cursor and status (see "Which Paperless" below).
//
//  - Starts fresh: the first run only records "now", so documents already in
//    Paperless are never imported in bulk.
//  - Settling: a document is only looked at once it has been unchanged for
//    SETTLE_MS, so retitle / paperless-gpt / a person can finish filling in
//    its fields first. Not-ready documents (no Amount, still in review) are
//    reported and come back on their own once edited, because editing bumps
//    their `modified`.
//  - Bills re-import in place when edited in Paperless; payments import once.
//  - A payment matching no unpaid bill is reported, never turned into a bill.

const SETTLE_MS = 10 * 60 * 1000;
/** How many skipped documents the status report remembers. */
const MAX_SKIPPED = 25;

const names = paperlessNames;

export function isPaperlessConfigured(): boolean {
  return paperlessConfig() !== null;
}

type PaperlessSyncResult = PaperlessSyncResultDTO;

interface ResolvedSetup {
  ctx: MappingContext;
  tagIds: number[];
  /** What the preview prints so a wrong name is obvious. */
  found: Record<string, string>;
}

/** Looks up the configured tag and field names; a required one missing is an error. */
async function resolveSetup(client: PaperlessClient, cfg: PaperlessConfig): Promise<ResolvedSetup> {
  const [tags, fields, correspondents] = await Promise.all([
    client.listAll<{ id: number; name: string }>('/api/tags/'),
    client.listAll<{ id: number; name: string; data_type: string }>('/api/custom_fields/'),
    client.listAll<{ id: number; name: string }>('/api/correspondents/'),
  ]);
  const tagId = (name: string) => tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id;
  const field = (name: string) => fields.find((f) => f.name.toLowerCase() === name.toLowerCase());

  const kindTags = new Map<number, DocKind>();
  const billTag = tagId(names.billTag());
  const paymentTag = tagId(names.paymentTag());
  if (billTag === undefined && paymentTag === undefined) {
    throw new Error(
      `Neither tag "${names.billTag()}" nor "${names.paymentTag()}" exists in Paperless (or the API user can't see them; tags must have no owner).`,
    );
  }
  if (billTag !== undefined) kindTags.set(billTag, 'bill');
  if (paymentTag !== undefined) kindTags.set(paymentTag, 'receipt');

  const amount = field(names.amountField());
  if (!amount) {
    throw new Error(`Custom field "${names.amountField()}" doesn't exist in Paperless (or the API user can't see it).`);
  }
  const due = field(names.dueDateField());
  const account = field(names.accountField());
  const invoice = field(names.invoiceField());
  const pending = names.pendingTags().map(tagId).filter((id): id is number => id !== undefined);

  const show = (f: { id: number } | number | undefined) =>
    f === undefined ? 'not found' : `id ${typeof f === 'number' ? f : f.id}`;
  return {
    ctx: {
      kindTags,
      pendingTagIds: new Set(pending),
      fields: { amount: amount.id, dueDate: due?.id, accountNo: account?.id, invoiceNo: invoice?.id },
      correspondents: new Map(correspondents.map((c) => [c.id, c.name])),
      publicUrl: cfg.publicUrl,
    },
    tagIds: [...kindTags.keys()],
    found: {
      [`tag "${names.billTag()}"`]: show(billTag),
      [`tag "${names.paymentTag()}"`]: show(paymentTag),
      [`review tags "${names.pendingTags().join(', ')}"`]: pending.length ? `ids ${pending.join(', ')}` : 'none found',
      [`field "${names.amountField()}"`]: `${show(amount)} (${amount.data_type})`,
      [`field "${names.dueDateField()}"`]: show(due),
      [`field "${names.accountField()}"`]: show(account),
      [`field "${names.invoiceField()}"`]: show(invoice),
      correspondents: String(correspondents.length),
    },
  };
}

async function fetchDocuments(
  client: PaperlessClient,
  tagIds: number[],
  after: Date,
  before: Date,
): Promise<PaperlessDocument[]> {
  return client.listAll<PaperlessDocument>('/api/documents/', {
    tags__id__in: tagIds.join(','),
    modified__gt: after.toISOString(),
    modified__lt: before.toISOString(),
    ordering: 'modified',
    fields: 'id,title,correspondent,tags,created,modified,custom_fields',
  });
}

function docUrl(cfg: PaperlessConfig, id: number): string | null {
  return cfg.publicUrl ? `${cfg.publicUrl.replace(/\/+$/, '')}/documents/${id}/details` : null;
}

function parseResult(text: string | null): PaperlessSyncResult | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as PaperlessSyncResult;
  } catch {
    return null;
  }
}

// --- Which Paperless each household uses ---------------------------------------
//
// One Paperless per household. A household's own saved connection
// (PaperlessConnection, Settings → Paperless) comes first. The server-wide one
// from settings.yml/.env (paperlessConfig) is kept for the household it was
// set up for — PAPERLESS_HOUSEHOLD_ID, else the server admin's — so existing
// installs keep importing without re-entering anything.

/** The household the server-wide settings.yml/.env connection belongs to. */
async function legacyHousehold(): Promise<string | null> {
  if (!paperlessConfig()) return null;
  const configured = process.env.PAPERLESS_HOUSEHOLD_ID?.trim();
  if (configured) return configured;
  await ensureServerAdmin();
  const admin = await prisma.user.findFirst({
    where: { isServerAdmin: true, householdId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { householdId: true },
  });
  if (admin?.householdId) return admin.householdId;
  const first = await prisma.household.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  return first?.id ?? null;
}

/**
 * May this household's Paperless be on the server's private network? The
 * server admin's own household may (its Paperless usually runs next to the
 * app); others only when the server admin allowed it on the Server page.
 */
export async function paperlessMayUsePrivateNetwork(householdId: string): Promise<boolean> {
  const [household, admin] = await Promise.all([
    prisma.household.findUnique({ where: { id: householdId }, select: { paperlessPrivateNetwork: true } }),
    prisma.user.findFirst({ where: { householdId, isServerAdmin: true }, select: { id: true } }),
  ]);
  return household?.paperlessPrivateNetwork === true || !!admin;
}

type ConnectionSource = 'household' | 'server';

/** The connection a household imports from, or null when it has none. */
async function connectionFor(
  householdId: string,
): Promise<{ cfg: PaperlessConfig; source: ConnectionSource } | null> {
  const saved = await prisma.paperlessConnection.findUnique({ where: { householdId } });
  if (saved) {
    const token = decryptSecret(saved.tokenEnc);
    if (!token) {
      throw new Error('The saved Paperless token can’t be read (the server’s secret changed). Enter the token again in Settings.');
    }
    const publicOnly = !(await paperlessMayUsePrivateNetwork(householdId));
    return { cfg: { url: saved.url, token, publicUrl: saved.publicUrl, publicOnly }, source: 'household' };
  }
  const legacy = paperlessConfig();
  if (legacy && (await legacyHousehold()) === householdId) return { cfg: legacy, source: 'server' };
  return null;
}

/**
 * Where each household's import comes from: its own saved connection, or the
 * server-wide settings.yml/.env one. Households missing from the map have none.
 */
export async function paperlessSources(): Promise<Map<string, ConnectionSource>> {
  const [saved, legacy] = await Promise.all([
    prisma.paperlessConnection.findMany({ select: { householdId: true } }),
    legacyHousehold().catch(() => null),
  ]);
  const out = new Map<string, ConnectionSource>(saved.map((c) => [c.householdId, 'household']));
  if (legacy && !out.has(legacy)) out.set(legacy, 'server');
  return out;
}

// --- Import runs -------------------------------------------------------------------

// One run at a time per household: the 15-minute sweep and "Check now" can overlap.
const running = new Map<string, Promise<PaperlessSyncResult | null>>();

/**
 * Import for one household, or (no id) for every active household with a
 * Paperless, each on its own so one household's broken Paperless doesn't stop
 * the rest. Returns the one household's result (null when it has no Paperless
 * or on its very first run, which only records the starting point). Errors are
 * stored on the household's sync record; a single-household run re-throws.
 */
export async function runPaperlessSync(householdId?: string): Promise<PaperlessSyncResult | null> {
  if (householdId) return runFor(householdId);
  const [saved, legacy] = await Promise.all([
    prisma.paperlessConnection.findMany({ select: { householdId: true } }),
    legacyHousehold(),
  ]);
  const ids = new Set(saved.map((c) => c.householdId));
  if (legacy) ids.add(legacy);
  for (const id of ids) {
    // Turned-off households, and ones whose Bills the server admin turned off
    // (the import only makes bills), are left alone.
    if (await isHouseholdDisabled(id)) continue;
    if (!(await isFeatureEnabled(id, 'bills'))) continue;
    await runFor(id).catch((err) => {
      console.warn(`[paperless] import for household ${id} failed; retrying next sweep:`, err instanceof Error ? err.message : err);
    });
  }
  return null;
}

function runFor(householdId: string): Promise<PaperlessSyncResult | null> {
  let run = running.get(householdId);
  if (!run) {
    run = syncOnce(householdId).finally(() => running.delete(householdId));
    running.set(householdId, run);
  }
  return run;
}

async function syncOnce(householdId: string): Promise<PaperlessSyncResult | null> {
  const connection = await connectionFor(householdId).catch(async (err: unknown) => {
    // A connection that can't be used (unreadable token) is shown on the card.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.paperlessSync.updateMany({ where: { householdId }, data: { lastRunAt: new Date(), lastError: message } });
    throw err;
  });
  if (!connection) return null;
  const { cfg } = connection;
  const now = new Date();

  const state = await prisma.paperlessSync.findUnique({ where: { householdId } });
  if (!state) {
    // Start fresh: nothing already in Paperless is imported.
    await prisma.paperlessSync.create({ data: { householdId, cursor: now, lastRunAt: now } });
    console.log(`[paperless] import switched on for household ${householdId}; importing documents changed after ${now.toISOString()}`);
    return null;
  }

  const windowEnd = new Date(now.getTime() - SETTLE_MS);
  const previous = parseResult(state.lastResult);
  const result: PaperlessSyncResult = { checked: 0, imported: {}, skipped: previous?.skipped ?? [] };
  let cursor = state.cursor;

  try {
    if (windowEnd > cursor) {
      const client = new PaperlessClient(cfg);
      const { ctx, tagIds } = await resolveSetup(client, cfg);
      const docs = await fetchDocuments(client, tagIds, cursor, windowEnd);
      result.checked = docs.length;

      for (const doc of docs) {
        const evaluation = evaluateDocument(doc, ctx);
        // A document seen again replaces its old skipped entry either way.
        result.skipped = result.skipped.filter((s) => s.id !== doc.id);
        if (!evaluation.ready) {
          result.skipped.unshift({ id: doc.id, title: doc.title, reason: evaluation.reason, url: docUrl(cfg, doc.id) });
        } else {
          const out = await ingestFinancialDoc(householdId, evaluation.input, {
            source: 'paperless',
            createUnmatchedReceipts: false,
          });
          result.imported[out.status] = (result.imported[out.status] ?? 0) + 1;
          if (out.status === 'skipped') {
            result.skipped.unshift({ id: doc.id, title: doc.title, reason: out.reason ?? 'skipped', url: docUrl(cfg, doc.id) });
          }
        }
        // Documents come oldest-change first, so everything up to here is done.
        // If a later one throws, the next run resumes after this one.
        cursor = new Date(doc.modified);
      }
      cursor = windowEnd;
    }
    result.skipped = result.skipped.slice(0, MAX_SKIPPED);
    await prisma.paperlessSync.update({
      where: { householdId },
      data: { cursor, lastRunAt: now, lastResult: JSON.stringify(result), lastError: null },
    });
    const counts = Object.entries(result.imported).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing new';
    console.log(`[paperless] household ${householdId}: checked ${result.checked} document(s): ${counts}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.paperlessSync.update({
      where: { householdId },
      data: { cursor, lastRunAt: now, lastResult: JSON.stringify(result), lastError: message },
    });
    throw err;
  }
}

// --- Status and the household's connection ------------------------------------------

export async function getPaperlessStatus(householdId: string, canEdit = false): Promise<PaperlessStatusDTO> {
  const [state, saved, legacy, privateOk] = await Promise.all([
    prisma.paperlessSync.findUnique({ where: { householdId } }),
    prisma.paperlessConnection.findUnique({ where: { householdId }, select: { url: true, publicUrl: true } }),
    legacyHousehold().catch(() => null),
    paperlessMayUsePrivateNetwork(householdId),
  ]);
  const serverCfg = !saved && legacy === householdId ? paperlessConfig() : null;
  const connection = saved
    ? { source: 'household' as const, url: saved.url, publicUrl: saved.publicUrl }
    : serverCfg
      ? { source: 'server' as const, url: serverCfg.url, publicUrl: serverCfg.publicUrl }
      : null;
  return {
    configured: connection !== null,
    connection,
    canEdit,
    privateNetworkAllowed: privateOk,
    since: state?.createdAt.toISOString() ?? null,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    lastResult: parseResult(state?.lastResult ?? null),
  };
}

/** True when the household imports from some Paperless (its own or the server's). */
export async function hasPaperless(householdId: string): Promise<boolean> {
  return (await getPaperlessStatus(householdId)).configured;
}

function cleanUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * Save the household's own Paperless (Head of House). The connection is tried
 * first — address allowed, token accepted, the bill tags and Amount field
 * present — and nothing is saved if that fails. A blank token keeps the saved
 * one. Pointing at a different Paperless starts the import fresh.
 */
export async function savePaperlessConnection(
  householdId: string,
  input: { url: string; publicUrl?: string | null; token?: string | null },
): Promise<PaperlessStatusDTO> {
  const url = cleanUrl(input.url);
  const publicUrl = input.publicUrl ? cleanUrl(input.publicUrl) : null;
  const existing = await prisma.paperlessConnection.findUnique({ where: { householdId } });
  let token = input.token?.trim() || null;
  if (!token && existing) token = decryptSecret(existing.tokenEnc);
  if (!token) throw new ConflictError('Enter the API token of a read-only Paperless user.');

  const publicOnly = !(await paperlessMayUsePrivateNetwork(householdId));
  const cfg: PaperlessConfig = { url, token, publicUrl, publicOnly };
  try {
    await resolveSetup(new PaperlessClient(cfg), cfg);
  } catch (err) {
    throw new ConflictError(`Couldn’t use that Paperless: ${err instanceof Error ? err.message : String(err)}`);
  }

  const data = { url, publicUrl, tokenEnc: encryptSecret(token) };
  await prisma.$transaction(async (tx) => {
    await tx.paperlessConnection.upsert({ where: { householdId }, create: { householdId, ...data }, update: data });
    // A different Paperless (or the first own one) starts from now, like a new install.
    if (!existing || existing.url !== url) await tx.paperlessSync.deleteMany({ where: { householdId } });
  });
  return getPaperlessStatus(householdId, true);
}

/** Forget the household's own Paperless (and its import progress). */
export async function removePaperlessConnection(householdId: string): Promise<PaperlessStatusDTO> {
  await prisma.$transaction([
    prisma.paperlessConnection.deleteMany({ where: { householdId } }),
    prisma.paperlessSync.deleteMany({ where: { householdId } }),
  ]);
  return getPaperlessStatus(householdId, true);
}

export interface PreviewRow {
  id: number;
  title: string;
  modified: string;
  evaluation: Evaluation;
}

/**
 * Read-only dry run for scripts/paperless-preview.ts: what the import would do
 * with documents changed in the last `days`, using the server-wide
 * settings.yml/.env connection. Writes nothing anywhere.
 */
export async function previewPaperless(days: number): Promise<{ found: Record<string, string>; rows: PreviewRow[] }> {
  const cfg = paperlessConfig();
  if (!cfg) throw new Error('Set PAPERLESS_URL and PAPERLESS_TOKEN first.');
  const client = new PaperlessClient(cfg);
  const { ctx, tagIds, found } = await resolveSetup(client, cfg);
  const now = new Date();
  const docs = await fetchDocuments(client, tagIds, new Date(now.getTime() - days * 86_400_000), now);
  return {
    found,
    rows: docs.map((doc) => ({ id: doc.id, title: doc.title, modified: doc.modified, evaluation: evaluateDocument(doc, ctx) })),
  };
}
