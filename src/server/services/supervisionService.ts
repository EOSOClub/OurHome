import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/services/errors';
import { canPush, pushSync, pushToMember } from '@/server/services/pushService';
import {
  SUPERVISED_SELECT,
  phoneSummaries,
  refreshPhoneAlerts,
  type PhoneSummary,
} from '@/server/services/phoneStatusService';
import {
  PHONE_RULE_COLUMNS,
  PHONE_RULE_LABELS,
  freshestPhone,
  phoneRules,
  setupProgress,
  setupRequired,
  type PhoneRuleColumns,
} from '@/lib/phoneHealth';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import {
  findIcon,
  forgetUsage,
  usageHistory,
  usageLabel,
  usageApps,
  usageNamesApp,
  usageSummaries,
} from '@/server/services/appUsageService';
import { blockedAppsByKid, isBlockedFor } from '@/server/services/appBlockService';
import { appLimitsByKid, isLimitedFor } from '@/server/services/appLimitService';
import { allowedApps, isScheduledFor, schedulesByKid } from '@/server/services/appScheduleService';
import { minutesOn, pointsBalances } from '@/server/services/pointsTimeService';
import { getPointsSettings, todayIn } from '@/server/services/pointsService';
import { namesOf } from '@/server/services/appBlockService';
import { USAGE_REFRESH_COOLDOWN_MS } from '@/lib/appUsage';
import { ALL_APPS, ALL_APPS_LABEL, limitLabel } from '@/lib/appLimits';
import { MAX_SCHEDULES, daysLabel, formatClock } from '@/lib/appSchedules';
import { rateLabel } from '@/lib/pointsTime';
import { formatMinutes } from '@/lib/appUsage';
import {
  RING_MS,
  RING_SHOWN_MS,
  RING_TTL_MS,
  ringPhase,
  stoppedAfterSec,
  type RingState,
} from '@/lib/ring';
import { ROLE_RANK, isUserRole } from '@/lib/enums';
import { can, canBeSupervised, canSupervise } from '@/lib/permissions';
import { sharingMode } from '@/lib/location';
import type { LookAfterDTO, RingDTO, SupervisionDTO, UsageHistoryDTO } from '@/lib/types';
import type { ReportRingInput } from '@/lib/validation/phone';
import type {
  SetAppBlockedInput,
  GiveExtraTimeInput,
  RemoveScheduleInput,
  SaveScheduleInput,
  SetPointsForTimeInput,
  SetAppLimitInput,
  SetPhoneRuleInput,
  SetRequiredSharingInput,
  SetSupervisorsInput,
  SetUsageSharingInput,
} from '@/lib/validation/supervision';

// Parental controls, step 1: the Head of House's list of which adults
// supervise which children and teens. The rules live in src/lib/permissions.ts
// (canSupervise / canBeSupervised); this keeps the list.

type Db = Prisma.TransactionClient | typeof prisma;

type Person = { id: string; name: string; role: string };

function byRankThenName(a: Person, b: Person): number {
  const ra = isUserRole(a.role) ? ROLE_RANK[a.role] : 0;
  const rb = isUserRole(b.role) ? ROLE_RANK[b.role] : 0;
  if (ra !== rb) return rb - ra;
  return a.name.localeCompare(b.name);
}

/** Who supervises each child and teen, as the Members page shows and edits it. */
export async function getSupervision(householdId: string): Promise<SupervisionDTO> {
  const [users, links] = await Promise.all([
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true, role: true },
    }),
    prisma.supervision.findMany({
      where: { householdId },
      select: { supervisorId: true, supervisedId: true },
    }),
  ]);
  const people = [...users].sort(byRankThenName);
  const supervisors = people.filter((u) => canSupervise(u.role));
  const linked = new Set(links.map((l) => `${l.supervisorId}:${l.supervisedId}`));
  return {
    supervisors: supervisors.map(({ id, name, role }) => ({ id, name, role })),
    // Built from the current roles, so a link whose roles no longer fit never shows.
    supervised: people
      .filter((u) => canBeSupervised(u.role))
      .map(({ id, name, role }) => ({
        id,
        name,
        role,
        supervisorIds: supervisors.filter((s) => linked.has(`${s.id}:${id}`)).map((s) => s.id),
      })),
  };
}

/**
 * Replace who supervises one child or teen (Head of House only). Every
 * supervisor must be an adult or above in the same household.
 */
export async function setSupervisors(
  householdId: string,
  actor: { id: string; role: string },
  input: SetSupervisorsInput,
): Promise<SupervisionDTO> {
  if (!can(actor.role, 'household:manage')) {
    throw new ForbiddenError('Only the Head of House can choose who supervises whom.');
  }
  const supervised = await prisma.user.findFirst({
    where: { id: input.supervisedId, householdId },
    select: { id: true, name: true, role: true },
  });
  if (!supervised) throw new NotFoundError('That member is not in this household.');
  if (!canBeSupervised(supervised.role)) {
    throw new ForbiddenError(`${supervised.name} can’t be supervised: only children and teens can.`);
  }

  const wanted = [...new Set(input.supervisorIds)];
  const supervisors = await loadSupervisors(householdId, wanted);

  const current = await prisma.supervision.findMany({
    where: { supervisedId: supervised.id },
    select: { supervisorId: true },
  });
  const currentIds = new Set(current.map((c) => c.supervisorId));
  const added = wanted.filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !wanted.includes(id));

  if (added.length || removed.length) {
    const names = supervisors.sort(byRankThenName).map((s) => s.name);
    await prisma.$transaction(async (tx) => {
      if (removed.length) {
        await tx.supervision.deleteMany({
          where: { supervisedId: supervised.id, supervisorId: { in: removed } },
        });
        // Nobody left to supervise them: required sharing is theirs again.
        await releaseIfUnsupervised(tx, [supervised.id]);
      }
      if (added.length) {
        await tx.supervision.createMany({
          data: added.map((supervisorId) => ({
            householdId,
            supervisorId,
            supervisedId: supervised.id,
            createdById: actor.id,
          })),
        });
      }
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: supervised.id,
          message: names.length
            ? `set who supervises ${supervised.name}: ${names.join(', ')}`
            : `removed everyone supervising ${supervised.name}`,
        },
        tx,
      );
    });
    // Who gets this child's phone alerts just changed.
    await refreshPhoneAlerts(householdId, new Date(), [supervised.id]);
    // Their phone checks in at once and learns whether it must Stay connected.
    pushSync(householdId, { userIds: [supervised.id] }, 'supervision');
  }

  return getSupervision(householdId);
}

/** The members [ids] of this household, each of whom must be allowed to supervise. */
async function loadSupervisors(householdId: string, ids: string[]): Promise<Person[]> {
  const supervisors = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, householdId },
        select: { id: true, name: true, role: true },
      })
    : [];
  if (supervisors.length !== ids.length) {
    throw new NotFoundError('That member is not in this household.');
  }
  const notAdult = supervisors.find((s) => !canSupervise(s.role));
  if (notAdult) {
    throw new ForbiddenError(`${notAdult.name} can’t supervise anyone: only adults, managers and the Head of House can.`);
  }
  return supervisors.sort(byRankThenName);
}

/**
 * Who will look after a member being added (Members → Add a member), checked
 * before the account is made with the same rules as [setSupervisors]: Head of
 * House only, a child or teen, adults or above from this household. Nothing
 * asked, nothing checked. Saved with [linkNewSupervisors].
 */
export async function newMemberSupervisors(
  householdId: string,
  actor: { id: string; role: string },
  role: string,
  supervisorIds: string[] | undefined,
): Promise<Person[]> {
  const wanted = [...new Set(supervisorIds ?? [])];
  if (wanted.length === 0) return [];
  if (!can(actor.role, 'household:manage')) {
    throw new ForbiddenError('Only the Head of House can choose who supervises whom.');
  }
  if (!canBeSupervised(role)) {
    throw new ForbiddenError('Only children and teens can be supervised.');
  }
  return loadSupervisors(householdId, wanted);
}

/** Saves [newMemberSupervisors]' answer for the member just made, in its transaction. */
export async function linkNewSupervisors(
  db: Db,
  householdId: string,
  actorId: string,
  supervisedId: string,
  supervisors: Person[],
): Promise<void> {
  if (supervisors.length === 0) return;
  await db.supervision.createMany({
    data: supervisors.map((s) => ({
      householdId,
      supervisorId: s.id,
      supervisedId,
      createdById: actorId,
    })),
  });
}

// --- What a supervising adult can do -------------------------------------------
// Only the adults the Head chose for a child; each action is logged in
// Activity, so nothing is done behind anyone's back.
//  - Ring their phone loudly, even on silent (Android: RingService). Their
//    phone says back that it rang and how it stopped (reportRing).
//  - Make their location sharing required: they can't turn it off, and their
//    supervisors may check where they are without their yes (permissions.ts
//    liveCheckAllowed). It goes back to "on" when nobody supervises them.
//  - Share their app usage with their supervisors (appUsageService). It goes
//    off, and what was kept is deleted, when nobody supervises them.
//  - Block apps from that usage on their phone (setAppBlocked), and give
//    apps, or all apps together, a daily limit (setAppLimit), and set
//    schedules when apps are closed (saveSchedule). All go when nobody
//    supervises them.
//  - Let them spend task points on more time on those limits
//    (setPointsForTime), and give them extra minutes (giveExtraTime).
//  - Be told when their phone goes quiet (phoneStatusService).

/** One ring per child at a time: the phone rings for about this long. */
export const RING_COOLDOWN_MS = RING_MS;

/** A ring older than this is no use: Firebase stops trying an offline phone. */
const RING_TTL_SEC = RING_TTL_MS / 1000;

/**
 * Each child's last ring, by their id: who rang, and what their phone said
 * back (POST /api/phone/ring). Kept in memory, only for a few minutes' use
 * (a restart forgets it, and the page then shows nothing). On globalThis so
 * the phone's route bundle and the supervisor's share one.
 */
type Ring = RingState & { ringId: string; householdId: string; ringerId: string };
const ringStore = globalThis as unknown as { __ourhomeRings?: Map<string, Ring> };
const rings = (ringStore.__ourhomeRings ??= new Map<string, Ring>());

/** [kidId]'s last ring, for the adult who rang it, while it's worth showing. */
function ringFor(kidId: string, viewerId: string, now: number): RingDTO | null {
  const ring = rings.get(kidId);
  if (!ring || ring.ringerId !== viewerId || now - ring.sentAt >= RING_SHOWN_MS) return null;
  return {
    sentAt: new Date(ring.sentAt).toISOString(),
    phase: ringPhase(ring, now),
    stoppedAfterSec: stoppedAfterSec(ring),
  };
}

/** The children and teens [actorId] supervises, while both roles still fit. */
async function supervisedBy(
  householdId: string,
  actorId: string,
): Promise<
  (Person & {
    locationSharing: string | null;
    shareAppUsage: boolean | null;
    mustChangePassword: boolean;
  } & PhoneRuleColumns)[]
> {
  const links = await prisma.supervision.findMany({
    where: { householdId, supervisorId: actorId },
    select: {
      supervisor: { select: { role: true } },
      supervised: {
        select: { id: true, name: true, role: true, mustChangePassword: true, ...SUPERVISED_SELECT },
      },
    },
  });
  return links
    .filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role))
    .map((l) => l.supervised)
    .sort(byRankThenName);
}

/** Ids of the children and teens [actorId] supervises right now. */
export async function supervisedIds(householdId: string, actorId: string): Promise<Set<string>> {
  return new Set((await supervisedBy(householdId, actorId)).map((k) => k.id));
}

/** Whether [supervisorId] supervises [supervisedId] right now (both roles still fit). */
export async function isSupervising(supervisorId: string, supervisedId: string): Promise<boolean> {
  const link = await prisma.supervision.findUnique({
    where: { supervisorId_supervisedId: { supervisorId, supervisedId } },
    select: { supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
  });
  return !!link && canSupervise(link.supervisor.role) && canBeSupervised(link.supervised.role);
}

/** The people the viewer looks after, and whether this server can ring phones. */
export async function lookAfterOverview(
  householdId: string,
  actorId: string,
  now: number = Date.now(),
): Promise<LookAfterDTO> {
  const kids = await supervisedBy(householdId, actorId);
  const shared = kids.filter((k) => k.shareAppUsage === true).map((k) => k.id);
  const ids = kids.map((k) => k.id);
  const [phones, usage, blocked, limits, schedules, usedApps, locationOn, pointsOn, settings, balances, rules] = await Promise.all([
    phoneSummaries(householdId, kids),
    usageSummaries(householdId, shared),
    blockedAppsByKid(householdId, kids.map((k) => k.id)),
    appLimitsByKid(householdId, kids.map((k) => k.id)),
    schedulesByKid(householdId, kids.map((k) => k.id)),
    usageApps(householdId, shared),
    isFeatureEnabled(householdId, 'location').catch(() => true),
    isFeatureEnabled(householdId, 'points').catch(() => true),
    getPointsSettings(householdId),
    pointsBalances(prisma, householdId, ids),
    prisma.pointsForTime.findMany({ where: { householdId, userId: { in: ids } } }),
  ]);
  const today = todayIn(settings, new Date(now));
  const [ruleNames, todays] = await Promise.all([
    namesOf(prisma, rules.map((r) => r.setById)),
    Promise.all(kids.map(async (k) => [k.id, await minutesOn(prisma, k.id, today)] as const)),
  ]);
  const minutesToday = new Map(todays);
  const pointsTimeOf = (kidId: string) => {
    const rule = rules.find((r) => r.userId === kidId);
    return {
      available: pointsOn,
      rule: rule
        ? {
            minutesPerPoint: rule.minutesPerPoint,
            dailyCap: rule.dailyCap,
            byName: ruleNames.get(rule.setById) ?? 'Someone who has left',
            at: rule.updatedAt.toISOString(),
          }
        : null,
      balanceCenti: balances.get(kidId) ?? 0,
      day: today,
      ...(minutesToday.get(kidId) ?? { bought: 0, given: 0 }),
    };
  };
  return {
    canRing: canPush(householdId),
    people: kids.map((k) => {
      const sharing = sharingMode(k.locationSharing);
      const rules = phoneRules(k);
      // Its checks only feed setup, blocking and limits below.
      const { checks = null, alwaysAllowed = [], ...phone } = phones.get(k.id) ?? {};
      const kidLimits = limits.get(k.id) ?? [];
      return {
        id: k.id,
        name: k.name,
        sharing,
        phone: phones.has(k.id) ? (phone as Omit<PhoneSummary, 'checks' | 'alwaysAllowed'>) : null,
        appUsage: { shared: k.shareAppUsage === true, latest: usage.get(k.id) ?? null },
        rules,
        blocking: {
          apps: blocked.get(k.id) ?? [],
          alwaysAllowed,
          works: checks?.keepRunning ?? null,
        },
        usageApps: (usedApps.get(k.id) ?? []).filter((a) => !alwaysAllowed.includes(a.app)),
        limits: {
          total: kidLimits.find((l) => l.app === ALL_APPS) ?? null,
          apps: kidLimits.filter((l) => l.app !== ALL_APPS),
          counts: checks?.usageAccess ?? null,
        },
        schedules: schedules.get(k.id) ?? [],
        pointsTime: pointsTimeOf(k.id),
        setup: {
          passwordChosen: !k.mustChangePassword,
          steps: setupProgress(
            setupRequired({ sharing, usageShared: k.shareAppUsage === true, locationOn, rules }),
            checks,
          ),
        },
        ring: ringFor(k.id, actorId, now),
      };
    }),
  };
}

/**
 * Require one protection on a supervised child's phone, or stop requiring
 * it ([PHONE_RULES]). Stopping only ends the alert and drops the step from
 * their phone's checklist: whatever is already on there stays on. Wakes
 * their phone so its checklist catches up.
 */
export async function setPhoneRule(
  householdId: string,
  actor: { id: string },
  input: SetPhoneRuleInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can change this. The Head of House chooses that on the Members page.',
    );
  }
  if (phoneRules(kid)[input.rule] !== input.required) {
    const label = PHONE_RULE_LABELS[input.rule];
    await prisma.$transaction(async (tx) => {
      // Required is stored as null (the default), so only "off" is ever written.
      await tx.user.update({
        where: { id: kid.id },
        data: { [PHONE_RULE_COLUMNS[input.rule]]: input.required ? null : false },
      });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: input.required
            ? `required ${label} on ${kid.name}’s phone`
            : `stopped requiring ${label} on ${kid.name}’s phone`,
        },
        tx,
      );
    });
    pushSync(householdId, { userIds: [kid.id] }, 'supervision');
    // Its alert only holds while it's required.
    await refreshPhoneAlerts(householdId, new Date(), [kid.id]);
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Turn sharing a supervised child's app usage with their supervisors on or
 * off. Off deletes what was stored. Wakes their phone so it starts (or stops)
 * measuring at once.
 */
export async function setUsageSharing(
  householdId: string,
  actor: { id: string },
  input: SetUsageSharingInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can change this. The Head of House chooses that on the Members page.',
    );
  }
  if ((kid.shareAppUsage === true) !== input.share) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: kid.id }, data: { shareAppUsage: input.share ? true : null } });
      if (!input.share) await forgetUsage(tx, householdId, [kid.id]);
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: input.share
            ? `turned on sharing ${kid.name}’s app usage`
            : `turned off sharing ${kid.name}’s app usage`,
        },
        tx,
      );
    });
    pushSync(householdId, { userIds: [kid.id] }, 'usage');
    // A "Usage access off" alert only holds while usage is shared.
    await refreshPhoneAlerts(householdId, new Date(), [kid.id]);
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Block an app on a supervised child's phone, or unblock it. Only an app
 * their stored usage names (its name comes from there), and never one their
 * phone always keeps open (its phone, messages, home screen, OurHome). Wakes
 * their phone, which checks in and learns the new list at once.
 */
export async function setAppBlocked(
  householdId: string,
  actor: { id: string },
  input: SetAppBlockedInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can block apps on their phone. The Head of House chooses that on the Members page.',
    );
  }
  const existing = await prisma.blockedApp.findUnique({
    where: { userId_app: { userId: kid.id, app: input.app } },
    select: { id: true, label: true },
  });
  let changed = false;
  if (input.blocked && !existing) {
    if (await keptOpen(householdId, kid.id, input.app)) {
      throw new ConflictError(
        `${kid.name}’s phone always keeps this app open: phone calls, messages, the home screen and OurHome can’t be blocked.`,
      );
    }
    const label = await usageLabel(kid.id, input.app);
    if (!label) throw new NotFoundError(`That app isn’t in ${kid.name}’s app usage.`);
    await prisma.$transaction(async (tx) => {
      await tx.blockedApp.create({
        data: { householdId, userId: kid.id, app: input.app, label, blockedById: actor.id },
      });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: `blocked ${label} on ${kid.name}’s phone`,
        },
        tx,
      );
    });
    changed = true;
  } else if (!input.blocked && existing) {
    await prisma.$transaction(async (tx) => {
      await tx.blockedApp.delete({ where: { id: existing.id } });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: `unblocked ${existing.label} on ${kid.name}’s phone`,
        },
        tx,
      );
    });
    changed = true;
  }
  // Their phone checks in at once and learns the new list.
  if (changed) pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  return lookAfterOverview(householdId, actor.id);
}

/** Whether [kidId]'s freshest phone always keeps [app] open (its phone, messages, home screen, OurHome). */
async function keptOpen(householdId: string, kidId: string, app: string): Promise<boolean> {
  const phones = await prisma.phoneStatus.findMany({
    where: { householdId, userId: kidId },
    select: { lastSeenAt: true, alwaysAllowed: true },
  });
  return freshestPhone(phones)?.alwaysAllowed.includes(app) ?? false;
}

/**
 * Give an app, or all apps together (app ALL_APPS), a daily limit on a
 * supervised child's phone, change it, or remove it (minutes null). One app
 * only from their stored usage (its name comes from there), and never one
 * their phone always keeps open. Wakes their phone, which checks in and
 * learns the new limits at once.
 */
export async function setAppLimit(
  householdId: string,
  actor: { id: string },
  input: SetAppLimitInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can set limits on their phone. The Head of House chooses that on the Members page.',
    );
  }
  const all = input.app === ALL_APPS;
  const existing = await prisma.appLimit.findUnique({
    where: { userId_app: { userId: kid.id, app: input.app } },
    select: { id: true, label: true, minutes: true },
  });
  const what = (label: string) => (all ? 'all apps' : label);
  let save: ((tx: Prisma.TransactionClient) => Promise<unknown>) | null = null;
  let message = '';
  if (input.minutes === null) {
    if (existing) {
      save = (tx) => tx.appLimit.delete({ where: { id: existing.id } });
      message = `removed the daily limit for ${what(existing.label)} on ${kid.name}’s phone`;
    }
  } else if (existing) {
    if (existing.minutes !== input.minutes) {
      const minutes = input.minutes;
      save = (tx) => tx.appLimit.update({ where: { id: existing.id }, data: { minutes, setById: actor.id } });
      message = `changed the limit for ${what(existing.label)} to ${limitLabel(minutes)} on ${kid.name}’s phone`;
    }
  } else {
    let label = ALL_APPS_LABEL;
    if (!all) {
      if (await keptOpen(householdId, kid.id, input.app)) {
        throw new ConflictError(
          `${kid.name}’s phone always keeps this app open: phone calls, messages, the home screen and OurHome have no limit.`,
        );
      }
      const named = await usageLabel(kid.id, input.app);
      if (!named) throw new NotFoundError(`That app isn’t in ${kid.name}’s app usage.`);
      label = named;
    }
    const minutes = input.minutes;
    save = (tx) =>
      tx.appLimit.create({
        data: { householdId, userId: kid.id, app: input.app, label, minutes, setById: actor.id },
      });
    message = `limited ${what(label)} to ${limitLabel(minutes)} on ${kid.name}’s phone`;
  }
  if (save) {
    const write = save;
    await prisma.$transaction(async (tx) => {
      await write(tx);
      await logActivity(
        { householdId, actorId: actor.id, verb: 'updated', subjectType: 'member', subjectId: kid.id, message },
        tx,
      );
    });
    // Their phone checks in at once and learns the new limits.
    pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Add a schedule to a supervised child's phone, or change one: a time window
 * when every app is closed apart from the ones their phone always keeps open
 * and [allowed] (named from their stored usage; ones already allowed keep
 * their name after leaving it). At most MAX_SCHEDULES. Wakes their phone,
 * which checks in and learns the new schedules at once.
 */
export async function saveSchedule(
  householdId: string,
  actor: { id: string },
  input: SaveScheduleInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can set schedules on their phone. The Head of House chooses that on the Members page.',
    );
  }
  const existing = input.id
    ? await prisma.appSchedule.findFirst({ where: { id: input.id, userId: kid.id } })
    : null;
  if (input.id && !existing) throw new NotFoundError('That schedule isn’t there any more. Reload the page.');
  if (!existing && (await prisma.appSchedule.count({ where: { userId: kid.id } })) >= MAX_SCHEDULES) {
    throw new ConflictError(`${kid.name} has ${MAX_SCHEDULES} schedules already. Remove one first.`);
  }
  const named = new Map(((await usageApps(householdId, [kid.id])).get(kid.id) ?? []).map((a) => [a.app, a.label]));
  for (const a of existing ? allowedApps(existing.allowed) : []) if (!named.has(a.app)) named.set(a.app, a.label);
  const apps = [...new Set(input.allowed)];
  if (apps.some((a) => !named.has(a))) throw new NotFoundError(`That app isn’t in ${kid.name}’s app usage.`);
  const data = {
    name: input.name,
    days: [...new Set(input.days)].sort((a, b) => a - b),
    start: input.start,
    end: input.end,
    allowed: JSON.stringify(apps.map((app) => ({ app, label: named.get(app)! }))),
    setById: actor.id,
  };
  const unchanged =
    existing &&
    existing.name === data.name &&
    existing.start === data.start &&
    existing.end === data.end &&
    existing.allowed === data.allowed &&
    [...existing.days].sort((a, b) => a - b).join() === data.days.join();
  if (!unchanged) {
    const when = `${daysLabel(data.days)}, ${formatClock(data.start)} to ${formatClock(data.end)}`;
    await prisma.$transaction(async (tx) => {
      if (existing) await tx.appSchedule.update({ where: { id: existing.id }, data });
      else await tx.appSchedule.create({ data: { householdId, userId: kid.id, ...data } });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: existing
            ? `changed ${data.name} on ${kid.name}’s phone (${when})`
            : `added ${data.name} to ${kid.name}’s phone (${when})`,
        },
        tx,
      );
    });
    // Their phone checks in at once and learns the new schedules.
    pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  }
  return lookAfterOverview(householdId, actor.id);
}

/** Remove a schedule from a supervised child's phone. Wakes their phone. */
export async function removeSchedule(
  householdId: string,
  actor: { id: string },
  input: RemoveScheduleInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can set schedules on their phone. The Head of House chooses that on the Members page.',
    );
  }
  const existing = await prisma.appSchedule.findFirst({
    where: { id: input.id, userId: kid.id },
    select: { id: true, name: true },
  });
  if (existing) {
    await prisma.$transaction(async (tx) => {
      await tx.appSchedule.delete({ where: { id: existing.id } });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: `removed ${existing.name} from ${kid.name}’s phone`,
        },
        tx,
      );
    });
    pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Let a supervised child spend task points on more time on their daily
 * limits, at [minutesPerPoint] a point and up to [dailyCap] minutes a day, or
 * stop it (minutesPerPoint null). Needs the household's Points feature.
 * Wakes their phone, which offers it from then on.
 */
export async function setPointsForTime(
  householdId: string,
  actor: { id: string },
  input: SetPointsForTimeInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can change this. The Head of House chooses that on the Members page.',
    );
  }
  const existing = await prisma.pointsForTime.findUnique({ where: { userId: kid.id } });
  let message: string | null = null;
  let write: ((tx: Prisma.TransactionClient) => Promise<unknown>) | null = null;
  if (input.minutesPerPoint === null) {
    if (existing) {
      write = (tx) => tx.pointsForTime.delete({ where: { id: existing.id } });
      message = `stopped ${kid.name} spending points on screen time`;
    }
  } else {
    if (!(await isFeatureEnabled(householdId, 'points').catch(() => true))) {
      throw new ConflictError('This household doesn’t use Points. The Head of House can turn it on in Settings.');
    }
    const data = { minutesPerPoint: input.minutesPerPoint, dailyCap: input.dailyCap, setById: actor.id };
    const what = `${rateLabel(data.minutesPerPoint)}, up to ${formatMinutes(data.dailyCap)} a day`;
    if (!existing) {
      write = (tx) => tx.pointsForTime.create({ data: { householdId, userId: kid.id, ...data } });
      message = `let ${kid.name} spend points on screen time (${what})`;
    } else if (existing.minutesPerPoint !== data.minutesPerPoint || existing.dailyCap !== data.dailyCap) {
      write = (tx) => tx.pointsForTime.update({ where: { id: existing.id }, data });
      message = `changed ${kid.name}’s points for screen time (${what})`;
    }
  }
  if (write && message) {
    const save = write;
    const line = message;
    await prisma.$transaction(async (tx) => {
      await save(tx);
      await logActivity(
        { householdId, actorId: actor.id, verb: 'updated', subjectType: 'member', subjectId: kid.id, message: line },
        tx,
      );
    });
    pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Give a supervised child [minutes] more on today's daily limits (today in the
 * household's time zone), without spending their points. Only while they have
 * a limit to add to. Wakes their phone, which adds the minutes.
 */
export async function giveExtraTime(
  householdId: string,
  actor: { id: string },
  input: GiveExtraTimeInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can change this. The Head of House chooses that on the Members page.',
    );
  }
  if ((await prisma.appLimit.count({ where: { householdId, userId: kid.id } })) === 0) {
    throw new ConflictError(`${kid.name} has no daily limits, so there’s nothing to add time to.`);
  }
  const day = todayIn(await getPointsSettings(householdId));
  await prisma.$transaction(async (tx) => {
    await tx.extraTime.create({
      data: { householdId, userId: kid.id, day, minutes: input.minutes, pointsCenti: 0, byId: actor.id },
    });
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'member',
        subjectId: kid.id,
        message: `gave ${kid.name} ${formatMinutes(input.minutes)} more screen time today`,
      },
      tx,
    );
  });
  pushSync(householdId, { userIds: [kid.id] }, 'supervision');
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Make a supervised child's location sharing required, or stop requiring it
 * (back to "on": they can turn it off themselves again). Wakes their phone so
 * it starts watching the map places at once.
 */
export async function setRequiredSharing(
  householdId: string,
  actor: { id: string },
  input: SetRequiredSharingInput,
): Promise<LookAfterDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === input.supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can change this. The Head of House chooses that on the Members page.',
    );
  }
  const current = sharingMode(kid.locationSharing);
  const next = input.required ? 'required' : current === 'required' ? 'on' : current;
  if (next !== current) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: kid.id }, data: { locationSharing: next } });
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: kid.id,
          message: input.required
            ? `made ${kid.name}’s location sharing required`
            : `stopped requiring ${kid.name}’s location sharing`,
        },
        tx,
      );
    });
    pushSync(householdId, { userIds: [kid.id] }, 'location');
    // A "location off" alert only holds while sharing is required.
    await refreshPhoneAlerts(householdId, new Date(), [kid.id]);
  }
  return lookAfterOverview(householdId, actor.id);
}

/**
 * Ring a supervised child's phone. Refused unless the actor supervises them,
 * while it's still ringing from the last time (until their phone says it
 * stopped), or when no phone answered. Returns the ring, to show how it goes.
 */
export async function ringPhone(
  householdId: string,
  actor: { id: string },
  targetId: string,
  now: number = Date.now(),
): Promise<RingDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === targetId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can ring their phone. The Head of House chooses that on the Members page.',
    );
  }
  if (!canPush(householdId, kid.id)) {
    throw new ConflictError(
      `Ringing a phone needs instant phone alerts. This server doesn’t have Firebase set up, and ${kid.name}’s phone isn’t using Stay connected.`,
    );
  }
  const last = rings.get(kid.id);
  if (last && last.ended === null && now - last.sentAt < RING_COOLDOWN_MS) {
    throw new ConflictError(`${kid.name}’s phone is already ringing. Try again in a few seconds.`);
  }
  // Set before the push, so a second tap meanwhile is refused.
  const ringId = randomUUID();
  rings.set(kid.id, { ringId, householdId, ringerId: actor.id, sentAt: now, ringingAt: null, endedAt: null, ended: null });
  const reached = await pushToMember(
    householdId,
    kid.id,
    { type: 'ring', ringerId: actor.id, ringId },
    { ttlSec: RING_TTL_SEC },
  );
  if (reached === 0) {
    if (last) rings.set(kid.id, last);
    else rings.delete(kid.id);
    throw new ConflictError(
      `Couldn’t reach ${kid.name}’s phone. The OurHome app needs to be signed in there with instant alerts working.`,
    );
  }
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'updated',
    subjectType: 'member',
    subjectId: kid.id,
    message: `rang ${kid.name}’s phone`,
  });
  return ringFor(kid.id, actor.id, now)!;
}

/**
 * A rung phone saying what it did: started ringing, Stop was tapped, or it
 * rang out. Only the child's own phone, for their latest ring; anything else
 * (an older ring, a restarted server) is ignored, since the phone can't do
 * anything about it. The first phone to say how it ended decides, and ends
 * the wait for ringing again. Not logged: the ring itself is.
 */
export function reportRing(
  householdId: string,
  userId: string,
  input: ReportRingInput,
  now: number = Date.now(),
): { known: boolean } {
  const ring = rings.get(userId);
  if (!ring || ring.householdId !== householdId || ring.ringId !== input.ringId) return { known: false };
  if (input.state === 'ringing') {
    ring.ringingAt ??= now;
  } else if (ring.ended === null) {
    ring.ended = input.state;
    ring.endedAt = now;
  }
  return { known: true };
}

const lastUsageRefreshAt = new Map<string, number>();

/** A refresh older than this is no use: the page has been looked at already. */
const USAGE_REFRESH_TTL_SEC = 120;

/**
 * Asks a supervised child's phone to measure and send its app usage now (a
 * supervisor opened "People you look after"). Quietly does nothing when their
 * usage isn't shared, the server can't push, or their phone was asked less
 * than USAGE_REFRESH_COOLDOWN_MS ago: the page shows what's stored either way,
 * and the phone still reports every 15 minutes. Not logged in Activity: it
 * only reads what the supervisor may already see.
 */
export async function refreshUsage(
  householdId: string,
  actor: { id: string },
  supervisedId: string,
  now: number = Date.now(),
): Promise<{ asked: boolean }> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can see their app usage. The Head of House chooses that on the Members page.',
    );
  }
  if (kid.shareAppUsage !== true || !canPush(householdId, kid.id)) return { asked: false };
  const last = lastUsageRefreshAt.get(kid.id);
  if (last !== undefined && now - last < USAGE_REFRESH_COOLDOWN_MS) return { asked: false };
  lastUsageRefreshAt.set(kid.id, now);
  // Normal priority: the phone answers without a notification, and a stream of
  // silent high-priority pushes would get its ring demoted (fcm.ts).
  const reached = await pushToMember(
    householdId,
    kid.id,
    { type: 'usage_refresh' },
    { ttlSec: USAGE_REFRESH_TTL_SEC, priority: 'normal' },
  );
  if (reached === 0) lastUsageRefreshAt.delete(kid.id);
  return { asked: reached > 0 };
}

/**
 * Every stored day of a supervised child's app usage with all its apps: the
 * week's chart and the full list on "People you look after". Not logged in
 * Activity, like refreshUsage: the supervisor already sees the latest day.
 */
export async function supervisedUsageHistory(
  householdId: string,
  actor: { id: string },
  supervisedId: string,
): Promise<UsageHistoryDTO> {
  const kid = (await supervisedBy(householdId, actor.id)).find((k) => k.id === supervisedId);
  if (!kid) {
    throw new ForbiddenError(
      'Only an adult who supervises them can see their app usage. The Head of House chooses that on the Members page.',
    );
  }
  if (kid.shareAppUsage !== true) throw new ConflictError(`${kid.name}’s app usage isn’t shared.`);
  return usageHistory(householdId, kid.id);
}

/**
 * An app's icon (PNG), for a supervisor of a child whose shared usage names
 * the app or who has it blocked, limited or allowed in a schedule, or for the child themself (their Profile).
 * Not found otherwise, so nobody else can tell which apps a child has. A
 * member's own days only exist while their usage is shared: turning it off
 * deletes them.
 */
export async function usageIcon(householdId: string, actorId: string, app: string): Promise<Uint8Array> {
  const kids = await supervisedBy(householdId, actorId);
  const whose = [...kids.filter((k) => k.shareAppUsage === true).map((k) => k.id), actorId];
  // A blocked or limited app stays in their lists after it leaves their usage.
  const ids = kids.map((k) => k.id);
  const named =
    (await usageNamesApp(whose, app)) ||
    (await isBlockedFor(ids, app)) ||
    (await isLimitedFor(ids, app)) ||
    (await isScheduledFor(ids, app));
  const png = named ? await findIcon(householdId, app) : null;
  if (!png) throw new NotFoundError('No icon for that app.');
  return png;
}

/**
 * After someone's role changes: remove the links the new role no longer
 * allows (a supervisor who is no longer an adult, or a child or teen who
 * grew into an adult role).
 */
export async function dropBrokenSupervision(db: Db, userId: string, role: string): Promise<void> {
  const affected: string[] = [];
  if (!canSupervise(role)) {
    const theirs = await db.supervision.findMany({ where: { supervisorId: userId }, select: { supervisedId: true } });
    affected.push(...theirs.map((l) => l.supervisedId));
    await db.supervision.deleteMany({ where: { supervisorId: userId } });
  }
  if (!canBeSupervised(role)) {
    affected.push(userId);
    await db.supervision.deleteMany({ where: { supervisedId: userId } });
  }
  if (affected.length) await releaseIfUnsupervised(db, affected);
}

/**
 * Supervisors' controls only last while someone supervises them: anyone in
 * [userIds] with no supervisor left (or no longer a child or teen) gets
 * required sharing back as "on" (they may turn it off again), app usage
 * sharing off with what was stored deleted (nobody is left to see it), and
 * every app unblocked, every limit and schedule removed, and buying screen
 * time with points stopped (what they spent stays spent).
 */
export async function releaseIfUnsupervised(db: Db, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  const blocked = await db.blockedApp.findMany({ where: { userId: { in: ids } }, select: { userId: true } });
  const withBlocks = new Set(blocked.map((b) => b.userId));
  const limited = await db.appLimit.findMany({ where: { userId: { in: ids } }, select: { userId: true } });
  const withLimits = new Set(limited.map((l) => l.userId));
  const scheduled = await db.appSchedule.findMany({ where: { userId: { in: ids } }, select: { userId: true } });
  const withSchedules = new Set(scheduled.map((s) => s.userId));
  const buying = await db.pointsForTime.findMany({ where: { userId: { in: ids } }, select: { userId: true } });
  const withBuying = new Set(buying.map((b) => b.userId));
  const controlled = await db.user.findMany({
    where: {
      id: { in: ids },
      OR: [
        { locationSharing: 'required' },
        { shareAppUsage: true },
        { id: { in: [...new Set([...withBlocks, ...withLimits, ...withSchedules, ...withBuying])] } },
      ],
    },
    select: { id: true, role: true, householdId: true, locationSharing: true, shareAppUsage: true },
  });
  for (const user of controlled) {
    const links = canBeSupervised(user.role)
      ? await db.supervision.findMany({
          where: { supervisedId: user.id },
          select: { supervisor: { select: { role: true } } },
        })
      : [];
    if (links.some((l) => canSupervise(l.supervisor.role))) continue;
    if (user.locationSharing === 'required') {
      await db.user.update({ where: { id: user.id }, data: { locationSharing: 'on' } });
    }
    // Before forgetting their usage, so pruning icons no longer keeps these apps'.
    if (withBlocks.has(user.id)) await db.blockedApp.deleteMany({ where: { userId: user.id } });
    if (withLimits.has(user.id)) await db.appLimit.deleteMany({ where: { userId: user.id } });
    if (withSchedules.has(user.id)) await db.appSchedule.deleteMany({ where: { userId: user.id } });
    if (withBuying.has(user.id)) await db.pointsForTime.deleteMany({ where: { userId: user.id } });
    if (user.shareAppUsage) {
      await db.user.update({ where: { id: user.id }, data: { shareAppUsage: null } });
      if (user.householdId) await forgetUsage(db, user.householdId, [user.id]);
      else await db.appUsageDay.deleteMany({ where: { userId: user.id } });
    }
  }
}
