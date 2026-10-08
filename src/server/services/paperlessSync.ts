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
// and from Settings → "Check now". Read-only towards Paperless.
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

/** The household Paperless feeds: PAPERLESS_HOUSEHOLD_ID, or the only one there is. */
async function targetHousehold(): Promise<string> {
  const configured = process.env.PAPERLESS_HOUSEHOLD_ID?.trim();
  if (configured) return configured;
  const households = await prisma.household.findMany({ select: { id: true }, take: 2 });
  if (households.length === 1) return households[0].id;
  throw new Error(
    households.length === 0
      ? 'No household exists yet.'
      : 'More than one household exists; set PAPERLESS_HOUSEHOLD_ID to the one Paperless belongs to.',
  );
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

// One run at a time per process: the 15-minute sweep and "Check now" can overlap.
let running: Promise<PaperlessSyncResult | null> | null = null;

/**
 * One import pass. Returns null when the import is off, or on the very first
 * run (which only records the starting point). Errors are stored on the sync
 * record and re-thrown for the caller to report.
 */
export function runPaperlessSync(): Promise<PaperlessSyncResult | null> {
  running ??= syncOnce().finally(() => {
    running = null;
  });
  return running;
}

async function syncOnce(): Promise<PaperlessSyncResult | null> {
  const cfg = paperlessConfig();
  if (!cfg) return null;
  const householdId = await targetHousehold();
  const now = new Date();

  const state = await prisma.paperlessSync.findUnique({ where: { householdId } });
  if (!state) {
    // Start fresh: nothing already in Paperless is imported.
    await prisma.paperlessSync.create({ data: { householdId, cursor: now, lastRunAt: now } });
    console.log(`[paperless] import switched on; importing documents changed after ${now.toISOString()}`);
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
    console.log(`[paperless] checked ${result.checked} document(s): ${counts}`);
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

export async function getPaperlessStatus(householdId: string): Promise<PaperlessStatusDTO> {
  const state = await prisma.paperlessSync.findUnique({ where: { householdId } });
  return {
    configured: isPaperlessConfigured(),
    since: state?.createdAt.toISOString() ?? null,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastError: state?.lastError ?? null,
    lastResult: parseResult(state?.lastResult ?? null),
  };
}

export interface PreviewRow {
  id: number;
  title: string;
  modified: string;
  evaluation: Evaluation;
}

/**
 * Read-only dry run for scripts/paperless-preview.ts: what the import would do
 * with documents changed in the last `days`. Writes nothing anywhere.
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
