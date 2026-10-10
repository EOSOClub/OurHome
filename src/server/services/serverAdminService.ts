import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { auth } from '@/server/auth/auth';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/services/errors';
import type {
  CreateHouseholdInput,
  ResetHeadPasswordInput,
} from '@/lib/validation/server';

// Several households can share one server. The server admin owns the server
// itself: they create households (each with its own Head of House), can shut
// one out, and hold the server-wide settings (HTTPS only, contact-form
// messages). Being server admin doesn't open other households: their data
// stays visible only to their own members. One household per person.

type Tx = Prisma.TransactionClient;

/** Starter categories, so the task, shopping and inventory pickers aren't empty. */
const DEFAULT_CATEGORIES = [
  { name: 'Cleaning', kind: 'task', color: '#38bdf8' },
  { name: 'Pets', kind: 'task', color: '#f472b6' },
  { name: 'Maintenance', kind: 'task', color: '#fbbf24' },
  { name: 'Yard', kind: 'task', color: '#34d399' },
  { name: 'Grocery', kind: 'shopping', color: '#a78bfa' },
  { name: 'Supplies', kind: 'shopping', color: '#f87171' },
  { name: 'Pantry', kind: 'inventory', color: '#fb923c' },
];

// --- Who is server admin --------------------------------------------------------

let adminEnsured = false;

/**
 * Installs from before server admins existed have none: the Head of House of
 * the oldest household (whoever set the server up) becomes it, once.
 */
export async function ensureServerAdmin(): Promise<void> {
  if (adminEnsured) return;
  const existing = await prisma.user.count({ where: { isServerAdmin: true } });
  if (existing === 0) {
    const first = await prisma.household.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const head = first
      ? await prisma.user.findFirst({
          where: { householdId: first.id, role: 'head' },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      : null;
    if (!head) return; // fresh install: setup makes the first account server admin
    await prisma.user.update({ where: { id: head.id }, data: { isServerAdmin: true } });
  }
  adminEnsured = true;
}

export async function isServerAdmin(userId: string): Promise<boolean> {
  await ensureServerAdmin();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isServerAdmin: true } });
  return user?.isServerAdmin === true;
}

export async function assertServerAdmin(userId: string): Promise<void> {
  if (!(await isServerAdmin(userId))) {
    throw new ForbiddenError('Only the server admin can do that.');
  }
}

// --- Disabled households ---------------------------------------------------------

// Read on every request, so cached briefly; changes here clear it at once.
const DISABLED_TTL_MS = 30_000;
let disabledCache: { ids: Set<string>; at: number } | null = null;

export const HOUSEHOLD_DISABLED_MESSAGE =
  'This household has been turned off by the server admin. Ask them to turn it back on.';

/** Forget cached household state (after a household is turned off/on or deleted). */
export function clearHouseholdCaches(): void {
  disabledCache = null;
}

export async function isHouseholdDisabled(householdId: string): Promise<boolean> {
  if (!disabledCache || Date.now() - disabledCache.at > DISABLED_TTL_MS) {
    const rows = await prisma.household.findMany({
      where: { disabledAt: { not: null } },
      select: { id: true, disabledAt: true },
    });
    // Mongo: "not null" can also match unset fields, so check the value.
    disabledCache = { ids: new Set(rows.filter((r) => r.disabledAt).map((r) => r.id)), at: Date.now() };
  }
  return disabledCache.ids.has(householdId);
}

// --- Households ---------------------------------------------------------------------

export interface HouseholdSummaryDTO {
  id: string;
  name: string;
  createdAt: string;
  disabled: boolean;
  members: number;
  head: { id: string; name: string; username: string | null } | null;
  /** Latest activity-log entry; null = nothing yet. */
  lastActivityAt: string | null;
  /** The server admin's own household (can't be turned off). */
  isOwn: boolean;
  /** Its Paperless may be on the server's private network (own household: always). */
  paperlessPrivateNetwork: boolean;
  /** Where its Paperless import comes from: its own connection (Settings), the
   *  server-wide settings.yml one, or none. */
  paperless: 'household' | 'server' | null;
}

export async function listHouseholds(adminId: string): Promise<HouseholdSummaryDTO[]> {
  const [households, users, activity, admin, paperless] = await Promise.all([
    prisma.household.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.user.findMany({
      select: { id: true, name: true, displayUsername: true, username: true, role: true, householdId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.activityEntry.groupBy({ by: ['householdId'], _max: { createdAt: true } }),
    prisma.user.findUnique({ where: { id: adminId }, select: { householdId: true } }),
    // Imported here, not at the top: paperlessSync itself uses this module.
    import('@/server/services/paperlessSync').then((m) => m.paperlessSources()),
  ]);
  const last = new Map(activity.map((a) => [a.householdId, a._max.createdAt]));
  return households.map((h) => {
    const members = users.filter((u) => u.householdId === h.id);
    const head = members.find((u) => u.role === 'head') ?? null;
    return {
      id: h.id,
      name: h.name,
      createdAt: h.createdAt.toISOString(),
      disabled: !!h.disabledAt,
      members: members.length,
      head: head ? { id: head.id, name: head.name, username: head.displayUsername ?? head.username } : null,
      lastActivityAt: last.get(h.id)?.toISOString() ?? null,
      isOwn: h.id === admin?.householdId,
      paperlessPrivateNetwork: h.id === admin?.householdId || h.paperlessPrivateNetwork === true,
      paperless: paperless.get(h.id) ?? null,
    };
  });
}

/** Usernames and emails are unique across the whole server (one sign-in, no household picker). */
async function assertAccountFree(db: Tx | typeof prisma, username: string, email: string): Promise<void> {
  const clash = await db.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } });
  if (clash) throw new ConflictError('That username or email is already used on this server.');
}

/**
 * A household with starter categories and its Head of House (also used by
 * first-run setup). Returns the new ids.
 */
export async function createHouseholdWithHead(
  tx: Tx,
  input: {
    householdName: string;
    head: { name: string; username: string; email?: string; password: string };
    /** First-run setup: the head is also the server admin. */
    serverAdmin?: boolean;
    /** Admin-created heads get a temporary password they must change. */
    mustChangePassword?: boolean;
  },
): Promise<{ householdId: string; headId: string; username: string }> {
  const displayUsername = input.head.username.trim();
  const username = displayUsername.toLowerCase();
  const email = (input.head.email?.trim() || `${username}@household.local`).toLowerCase();
  await assertAccountFree(tx, username, email);

  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(input.head.password);

  const household = await tx.household.create({ data: { name: input.householdName.trim() } });
  await tx.category.createMany({
    data: DEFAULT_CATEGORIES.map((c) => ({ ...c, householdId: household.id })),
  });
  const head = await tx.user.create({
    data: {
      name: input.head.name.trim() || displayUsername,
      email,
      emailVerified: false,
      username,
      displayUsername,
      role: 'head',
      householdId: household.id,
      mustChangePassword: input.mustChangePassword ?? false,
      ...(input.serverAdmin ? { isServerAdmin: true } : {}),
    },
  });
  await tx.account.create({
    data: { accountId: head.id, providerId: 'credential', userId: head.id, password: hashed },
  });
  await logActivity(
    {
      householdId: household.id,
      actorId: input.serverAdmin ? head.id : null,
      verb: 'created',
      subjectType: 'household',
      subjectId: household.id,
      message: input.serverAdmin
        ? `set up the household “${household.name}”`
        : `household “${household.name}” created by the server admin`,
    },
    tx,
  );
  return { householdId: household.id, headId: head.id, username };
}

export async function createHousehold(adminId: string, input: CreateHouseholdInput): Promise<HouseholdSummaryDTO> {
  await assertServerAdmin(adminId);
  const { householdId } = await prisma.$transaction((tx) =>
    createHouseholdWithHead(tx, { ...input, mustChangePassword: true }),
  );
  const all = await listHouseholds(adminId);
  return all.find((h) => h.id === householdId)!;
}

/**
 * Turn a household off (its members are signed out and refused until it's
 * turned back on) or on again. Nothing is deleted. The admin's own household
 * can't be turned off — that would lock the admin out.
 */
export async function setHouseholdDisabled(adminId: string, householdId: string, disabled: boolean): Promise<void> {
  await assertServerAdmin(adminId);
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { householdId: true } });
  if (disabled && admin?.householdId === householdId) {
    throw new ConflictError('You can’t turn off your own household.');
  }
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { id: true } });
  if (!household) throw new NotFoundError('Household not found.');
  await prisma.$transaction(async (tx) => {
    await tx.household.update({ where: { id: householdId }, data: { disabledAt: disabled ? new Date() : null } });
    if (disabled) await tx.session.deleteMany({ where: { user: { householdId } } });
    // Phones of a turned-off household stop getting pushes.
    if (disabled) await tx.pushDevice.deleteMany({ where: { householdId } });
  });
  disabledCache = null;
}

/** A locked-out Head of House: new temporary password, signed out everywhere. */
export async function resetHeadPassword(adminId: string, input: ResetHeadPasswordInput): Promise<void> {
  await assertServerAdmin(adminId);
  const head = await prisma.user.findFirst({
    where: { householdId: input.id, role: 'head' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!head) throw new NotFoundError('That household has no Head of House.');
  if (head.id === adminId) throw new ConflictError('Change your own password on your Profile.');
  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(input.password);
  await prisma.$transaction(async (tx) => {
    const cred = await tx.account.findFirst({ where: { userId: head.id, providerId: 'credential' }, select: { id: true } });
    if (cred) await tx.account.update({ where: { id: cred.id }, data: { password: hashed } });
    else await tx.account.create({ data: { accountId: head.id, providerId: 'credential', userId: head.id, password: hashed } });
    await tx.user.update({ where: { id: head.id }, data: { mustChangePassword: true } });
    await tx.session.deleteMany({ where: { userId: head.id } });
  });
}

/**
 * Let a household's Paperless be on the server's private network (Docker,
 * LAN), or take that back. Off, its Paperless must be a public address — the
 * server won't connect to its own network on that household's say-so.
 */
export async function setPaperlessPrivateNetwork(adminId: string, householdId: string, allowed: boolean): Promise<void> {
  await assertServerAdmin(adminId);
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { id: true } });
  if (!household) throw new NotFoundError('Household not found.');
  await prisma.household.update({ where: { id: householdId }, data: { paperlessPrivateNetwork: allowed } });
}
