import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { auth } from '@/server/auth/auth';
import { ConflictError } from '@/server/services/errors';
import { EXPORT_VERSION } from '@/server/services/householdDataService';
import { assertServerAdmin } from '@/server/services/serverAdminService';

// Restore a household from its export (householdDataService.exportHousehold)
// as a new household on this server (server admin, Server page).
//
// - Every record gets a fresh id and every reference is rewired — including
//   ids inside text (rotation lists, undo snapshots, notification keys, JSON
//   settings) — so a restore never collides with what's on the server, even
//   when the original household still exists.
// - Only fields the current schema knows are written, so exports from older
//   or newer versions load (missing fields take their defaults).
// - The export has no passwords: the head gets the temporary password the
//   admin chose (changed at first sign-in); everyone else comes back without
//   one and the head sets theirs from Members → Reset password.
// - Not restored, because their tokens were never exported: the Home
//   Assistant and Paperless connections.

/** The export's id format: Prisma cuid() — "c" + 24 lowercase letters/digits. */
const ID_PATTERN = /\bc[a-z0-9]{24}\b/g;

type Row = Record<string, unknown>;

/** Each model's own (scalar) fields; relations and unknown keys are dropped. */
function scalarFields(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
  if (!m) throw new Error(`Unknown model ${model}`);
  return new Set(m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name));
}

/** The models a restore writes, in insert order (parents before children). */
export const RESTORE_ORDER = [
  'Household',
  'User',
  'Category',
  'RecurrenceRule',
  'Task',
  'Subtask',
  'TaskCompletion',
  'PointAward',
  'PendingCredit',
  'Event',
  'EventAttendee',
  'Bill',
  'BillPayment',
  'ShoppingList',
  'ShoppingItem',
  'Request',
  'BugReport',
  'InventoryItem',
  'Purchase',
  'Notification',
  'NfcTag',
  'ActivityEntry',
] as const;
export type RestoreModel = (typeof RESTORE_ORDER)[number];

export interface RestorePlan {
  rows: Record<RestoreModel, Row[]>;
  /** The restored household's new id and its head's new id. */
  householdId: string;
  headId: string;
  /** Usernames and emails the restore needs (must be free on the server). */
  usernames: string[];
  emails: string[];
  /** What couldn't come back, for the admin. */
  notes: string[];
}

function asArray(v: unknown): Row[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
}

/**
 * Turn an export into fresh rows for this server. Pure (no database), so the
 * id rewiring is unit-tested. Throws a ConflictError with a readable reason
 * when the file isn't a usable export.
 */
export function planRestore(
  data: unknown,
  opts: { name?: string; newId?: () => string; fields?: (model: string) => Set<string> } = {},
): RestorePlan {
  const newId = opts.newId ?? createCuid;
  const fieldsOf = opts.fields ?? scalarFields;
  if (!data || typeof data !== 'object') throw new ConflictError('That file isn’t an Our Home household export.');
  const doc = data as Row;
  if (doc.format !== 'ourhome-household-export') throw new ConflictError('That file isn’t an Our Home household export.');
  if (typeof doc.version !== 'number' || doc.version > EXPORT_VERSION) {
    throw new ConflictError('That export comes from a newer version of Our Home; update this server first.');
  }
  const household = doc.household as Row | undefined;
  if (!household || typeof household.id !== 'string') throw new ConflictError('The export has no household in it.');

  const members = asArray(doc.members);
  const head = members.find((m) => m.role === 'head');
  if (!head) throw new ConflictError('The export has no Head of House to restore.');

  // Collect the export's rows per model (children split out of their parents).
  const tasks = asArray(doc.tasks);
  const events = asArray(doc.calendar);
  const bills = asArray(doc.bills);
  const lists = asArray(doc.shoppingLists);
  const points = (doc.points ?? {}) as Row;
  const inventory = (doc.inventory ?? {}) as Row;
  const recurrence = [...tasks, ...events, ...bills]
    .map((r) => r.recurrence)
    .filter((r): r is Row => !!r && typeof r === 'object');

  const source: Record<RestoreModel, Row[]> = {
    Household: [household],
    User: members,
    Category: asArray(doc.categories),
    RecurrenceRule: recurrence,
    Task: tasks,
    Subtask: tasks.flatMap((t) => asArray(t.subtasks)),
    TaskCompletion: tasks.flatMap((t) => asArray(t.completions)),
    PointAward: asArray(points.awards),
    PendingCredit: asArray(points.pending),
    Event: events,
    EventAttendee: events.flatMap((e) => asArray(e.attendees)),
    Bill: bills,
    BillPayment: asArray(doc.billPayments),
    ShoppingList: lists,
    ShoppingItem: lists.flatMap((l) => asArray(l.items)),
    Request: asArray(doc.requests),
    BugReport: asArray(doc.bugReports),
    InventoryItem: asArray(inventory.items),
    Purchase: asArray(inventory.purchases),
    Notification: asArray(doc.notifications),
    NfcTag: asArray(doc.nfcTags),
    ActivityEntry: asArray(doc.activity),
  };

  // Old id → new id, for every record in the export.
  const idMap = new Map<string, string>();
  for (const model of RESTORE_ORDER) {
    for (const row of source[model]) {
      if (typeof row.id === 'string' && !idMap.has(row.id)) idMap.set(row.id, newId());
    }
  }
  const rewire = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(ID_PATTERN, (id) => idMap.get(id) ?? id);
    if (Array.isArray(value)) return value.map(rewire);
    return value;
  };

  const rows = {} as Record<RestoreModel, Row[]>;
  for (const model of RESTORE_ORDER) {
    const allowed = fieldsOf(model);
    rows[model] = source[model].map((row) => {
      const out: Row = {};
      for (const [key, value] of Object.entries(row)) {
        if (allowed.has(key) && value !== undefined) out[key] = rewire(value);
      }
      return out;
    });
  }

  // The household and its members as a fresh start on this server.
  const hh = rows.Household[0];
  if (opts.name?.trim()) hh.name = opts.name.trim();
  delete hh.disabledAt;
  delete hh.paperlessPrivateNetwork;
  for (const user of rows.User) {
    user.mustChangePassword = true;
    user.emailVerified = false;
    delete user.isServerAdmin;
  }

  const notes: string[] = [];
  if (asArray(doc.homeAssistant).length) notes.push('Home Assistant: reconnect it in Settings (its token isn’t in exports).');
  if (doc.paperless) notes.push('Paperless: the Head of House reconnects it in Settings (its token isn’t in exports).');
  const others = rows.User.length - 1;
  if (others > 0) {
    notes.push(
      `${others} other member${others === 1 ? '' : 's'} need${others === 1 ? 's' : ''} a temporary password: the Head of House sets it in Members → Reset password.`,
    );
  }

  return {
    rows,
    householdId: hh.id as string,
    headId: idMap.get(head.id as string)!,
    usernames: rows.User.map((u) => u.username).filter((u): u is string => typeof u === 'string'),
    emails: rows.User.map((u) => u.email).filter((e): e is string => typeof e === 'string'),
    notes,
  };
}

/**
 * An id shaped like Prisma's cuid() ("c" + 24 lowercase letters/digits): a
 * time part (sortable, like cuid's) then random. Collision odds are
 * negligible at household scale, and the unique _id would refuse one anyway.
 */
let lastStamp = '';
let counter = 0;
function createCuid(): string {
  const stamp = Date.now().toString(36).padStart(9, '0').slice(-9);
  counter = stamp === lastStamp ? counter + 1 : 0;
  lastStamp = stamp;
  const random = BigInt(`0x${randomBytes(10).toString('hex')}`).toString(36).padStart(12, '0').slice(-12);
  return `c${stamp}${counter.toString(36).padStart(3, '0').slice(-3)}${random}`;
}

export interface RestoreReport {
  householdId: string;
  name: string;
  headUsername: string;
  counts: Partial<Record<RestoreModel, number>>;
  notes: string[];
}

/**
 * Restore an export as a new household (server admin). Refused, with the
 * clashes listed, when a member's username or email is already used on the
 * server. One transaction: all of it, or nothing.
 */
export async function restoreHousehold(
  adminId: string,
  data: unknown,
  opts: { name?: string; headPassword: string },
): Promise<RestoreReport> {
  await assertServerAdmin(adminId);
  const plan = planRestore(data, { name: opts.name });

  const clashes = await prisma.user.findMany({
    where: { OR: [{ username: { in: plan.usernames } }, { email: { in: plan.emails } }] },
    select: { username: true, email: true },
  });
  if (clashes.length) {
    const taken = clashes.map((c) => c.username ?? c.email).join(', ');
    throw new ConflictError(
      `These accounts already exist on this server: ${taken}. Delete or rename them (or the household they belong to) first.`,
    );
  }

  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(opts.headPassword);
  const counts: RestoreReport['counts'] = {};

  await prisma.$transaction(
    async (tx) => {
      for (const model of RESTORE_ORDER) {
        const rows = plan.rows[model];
        if (!rows.length) continue;
        const delegate = (tx as unknown as Record<string, { createMany: (a: { data: Row[] }) => Promise<{ count: number }> }>)[
          model.charAt(0).toLowerCase() + model.slice(1)
        ];
        const { count } = await delegate.createMany({ data: rows });
        counts[model] = count;
      }
      await tx.account.create({
        data: { accountId: plan.headId, providerId: 'credential', userId: plan.headId, password: hashed },
      });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );

  const head = plan.rows.User.find((u) => u.id === plan.headId)!;
  const name = plan.rows.Household[0].name as string;
  console.log(`[server] household "${name}" restored by ${adminId} as ${plan.householdId}:`, JSON.stringify(counts));
  return {
    householdId: plan.householdId,
    name,
    headUsername: (head.displayUsername ?? head.username) as string,
    counts,
    notes: plan.notes,
  };
}
