import { prisma } from '@/server/db/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/services/errors';
import { canPush, pushToMember } from '@/server/services/pushService';
import { canStartLiveCheck } from '@/lib/permissions';
import {
  LIVE_CHECK_LOG_DAYS,
  fitLiveCheck,
  isSharing,
  liveCheckChoices,
  liveCheckSettings,
  liveCheckState,
  locationConsent,
  type LiveCheckSettings,
} from '@/lib/location';
import type { LiveCheckDTO, LiveCheckLogDTO, LiveChecksOverviewDTO } from '@/lib/types';
import type {
  LiveCheckFixInput,
  LiveCheckSettingsInput,
  StartLiveCheckInput,
} from '@/lib/validation/location';

// Live location checks (vault: Location and Presence, step 4). An adult asks
// to see where someone is for a few minutes; the server wakes that person's
// phone with a push, the phone shows a notification for the whole check and
// sends a fix every interval. Only the latest fix is stored. When the check
// closes the fix is cleared (it becomes their last known point if they're
// away) and what's left is the log entry the checked person sees.
// Never hidden: no push reaching the phone means no check.

const withNames = {
  requester: { select: { name: true } },
  target: { select: { name: true } },
} as const;

interface CheckRow {
  id: string;
  householdId: string;
  requesterId: string;
  targetId: string;
  intervalSec: number;
  startedAt: Date;
  endsAt: Date;
  endedAt: Date | null;
  endedById: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  fixAt: Date | null;
  answeredAt: Date | null;
}

type NamedCheck = CheckRow & { requester: { name: string }; target: { name: string } };

function toDTO(check: NamedCheck, now: Date): LiveCheckDTO {
  const state = liveCheckState(check, now);
  const fix =
    state !== 'ended' && check.fixAt && check.lat != null && check.lng != null
      ? { lat: check.lat, lng: check.lng, accuracyM: check.accuracyM ?? null, at: check.fixAt.toISOString() }
      : null;
  return {
    id: check.id,
    requesterId: check.requesterId,
    requesterName: check.requester.name,
    targetId: check.targetId,
    targetName: check.target.name,
    startedAt: check.startedAt.toISOString(),
    endsAt: check.endsAt.toISOString(),
    intervalSec: check.intervalSec,
    state,
    fix,
  };
}

/**
 * Closes a check: stopped by `endedById`, or (null) ran its time. Someone
 * away keeps the last fix as their last known point; someone at a place is
 * shown at the place, so their exact spot isn't kept. Then the fix is cleared.
 */
async function closeCheck(check: CheckRow, now: Date, endedById: string | null): Promise<void> {
  if (check.endedAt) return;
  if (check.fixAt && check.lat != null && check.lng != null) {
    await prisma.memberLocation.updateMany({
      where: {
        userId: check.targetId,
        state: 'away',
        // Only when it's newer than the point already there.
        OR: [
          { pointAt: null, at: { lt: check.fixAt } },
          { pointAt: { lt: check.fixAt } },
        ],
      },
      data: { lat: check.lat, lng: check.lng, accuracyM: check.accuracyM, pointAt: check.fixAt },
    });
  }
  const endedAt = endedById ? now : new Date(Math.min(now.getTime(), check.endsAt.getTime()));
  await prisma.locationCheck.update({
    where: { id: check.id },
    data: { endedAt, endedById, lat: null, lng: null, accuracyM: null, fixAt: null },
  });
}

/**
 * Closes the household's checks whose time ran out, and forgets log entries
 * older than 30 days. Run before anything reads checks or presence, so a
 * check that ran out while nobody was looking still hands over its last fix.
 */
export async function closeExpiredLiveChecks(householdId: string, now: Date = new Date()): Promise<void> {
  const expired = await prisma.locationCheck.findMany({
    where: { householdId, endedAt: null, endsAt: { lte: now } },
  });
  for (const check of expired) await closeCheck(check, now, null);
  const cutoff = new Date(now.getTime() - LIVE_CHECK_LOG_DAYS * 24 * 60 * 60_000);
  await prisma.locationCheck.deleteMany({ where: { householdId, endedAt: { not: null }, startedAt: { lt: cutoff } } });
}

/** Ends every running check on a member (they stopped sharing or turned live checks off). */
export async function endLiveChecksOn(userId: string, now: Date = new Date()): Promise<void> {
  const running = await prisma.locationCheck.findMany({ where: { targetId: userId, endedAt: null } });
  for (const check of running) await closeCheck(check, now, userId);
}

// --- Settings (head) ---

export async function getLiveCheckSettings(householdId: string): Promise<LiveCheckSettings> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { liveCheckMaxMinutes: true, liveCheckMinIntervalSec: true },
  });
  if (!household) throw new NotFoundError('Household not found.');
  return liveCheckSettings(household);
}

export async function updateLiveCheckSettings(
  householdId: string,
  input: LiveCheckSettingsInput,
): Promise<LiveCheckSettings> {
  const household = await prisma.household.update({
    where: { id: householdId },
    data: { liveCheckMaxMinutes: input.maxMinutes, liveCheckMinIntervalSec: input.minIntervalSec },
    select: { liveCheckMaxMinutes: true, liveCheckMinIntervalSec: true },
  });
  return liveCheckSettings(household);
}

// --- Checks ---

/**
 * Everything the signed-in member needs: a check on them, checks they
 * started, their log, and who they may check.
 */
export async function liveChecksOverview(
  householdId: string,
  viewer: { id: string; role: string },
  now: Date = new Date(),
): Promise<LiveChecksOverviewDTO> {
  const userId = viewer.id;
  await closeExpiredLiveChecks(householdId, now);
  const cutoff = new Date(now.getTime() - LIVE_CHECK_LOG_DAYS * 24 * 60 * 60_000);
  const mayCheck = canStartLiveCheck(viewer, { id: '', consent: { sharing: 'on', liveChecks: true } });
  const [settings, onMe, started, log, members] = await Promise.all([
    getLiveCheckSettings(householdId),
    prisma.locationCheck.findFirst({ where: { householdId, targetId: userId, endedAt: null }, include: withNames }),
    prisma.locationCheck.findMany({
      where: { householdId, requesterId: userId, endedAt: null },
      include: withNames,
      orderBy: { startedAt: 'desc' },
    }),
    prisma.locationCheck.findMany({
      where: { householdId, targetId: userId, startedAt: { gte: cutoff } },
      include: withNames,
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    mayCheck
      ? prisma.user.findMany({
          where: { householdId, id: { not: userId }, liveChecks: true },
          select: { id: true, name: true, locationSharing: true, liveChecks: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
  ]);
  return {
    onMe: onMe ? toDTO(onMe, now) : null,
    started: started.map((c) => toDTO(c, now)),
    log: log.map((c) => logEntry(c, userId)),
    checkable: members
      .filter((m) => canStartLiveCheck(viewer, { id: m.id, consent: locationConsent(m) }))
      .map((m) => ({ id: m.id, name: m.name })),
    settings,
    choices: liveCheckChoices(settings),
    available: canPush(),
  };
}

function logEntry(check: NamedCheck, viewerId: string): LiveCheckLogDTO {
  return {
    id: check.id,
    requesterName: check.requester.name,
    startedAt: check.startedAt.toISOString(),
    endedAt: check.endedAt?.toISOString() ?? null,
    stoppedBy: check.endedById ? (check.endedById === viewerId ? 'me' : 'requester') : null,
    answered: check.answeredAt != null,
  };
}

/**
 * Starts a check on `input.targetId` and wakes their phone. Refused when the
 * server can't push, when the actor may not check them (an adult or above, on
 * someone who shares and allows checks), or while someone else is already
 * checking on them. Asking again while your own check runs returns it.
 */
export async function startLiveCheck(
  householdId: string,
  actor: { id: string; role: string },
  input: StartLiveCheckInput,
  now: Date = new Date(),
): Promise<LiveCheckDTO> {
  if (!canPush()) {
    throw new ConflictError(
      'Live checks need instant phone alerts (Firebase), and this server doesn’t have them set up.',
    );
  }
  const target = await prisma.user.findFirst({
    where: { id: input.targetId, householdId },
    select: { id: true, name: true, locationSharing: true, liveChecks: true },
  });
  if (!target) throw new NotFoundError('Member not found.');
  if (target.id === actor.id) throw new ForbiddenError('You can’t start a live check on yourself.');
  if (!canStartLiveCheck(actor, { id: target.id, consent: { sharing: 'on', liveChecks: true } })) {
    throw new ForbiddenError('Only adults can start a live location check.');
  }
  if (!canStartLiveCheck(actor, { id: target.id, consent: locationConsent(target) })) {
    throw new ForbiddenError(`${target.name} doesn’t allow live location checks.`);
  }

  await closeExpiredLiveChecks(householdId, now);
  const running = await prisma.locationCheck.findFirst({
    where: { householdId, targetId: target.id, endedAt: null },
    include: withNames,
  });
  if (running) {
    if (running.requesterId === actor.id) return toDTO(running, now);
    throw new ConflictError(`${running.requester.name} is already checking on ${target.name} right now.`);
  }

  const fit = fitLiveCheck(await getLiveCheckSettings(householdId), input.minutes, input.intervalSec);
  const check = await prisma.locationCheck.create({
    data: {
      householdId,
      requesterId: actor.id,
      targetId: target.id,
      intervalSec: fit.intervalSec,
      startedAt: now,
      endsAt: new Date(now.getTime() + fit.minutes * 60_000),
    },
    include: withNames,
  });
  const reached = await pushToMember(householdId, target.id, { type: 'live_check', checkId: check.id });
  if (reached === 0) {
    // Kept in their log (unanswered) all the same: an attempt is never hidden.
    await closeCheck(check, now, actor.id);
    throw new ConflictError(
      `Couldn’t reach ${target.name}’s phone. The OurHome app needs to be signed in there with instant alerts working.`,
    );
  }
  return toDTO(check, now);
}

/** One check, for the person checking (polling the map) or the person checked. */
export async function getLiveCheck(
  householdId: string,
  viewerId: string,
  id: string,
  now: Date = new Date(),
): Promise<LiveCheckDTO> {
  const check = await findForParty(householdId, viewerId, id);
  if (!check.endedAt && liveCheckState(check, now) === 'ended') {
    await closeCheck(check, now, null);
    return toDTO(await findForParty(householdId, viewerId, id), now);
  }
  return toDTO(check, now);
}

async function findForParty(householdId: string, viewerId: string, id: string): Promise<NamedCheck> {
  const check = await prisma.locationCheck.findFirst({ where: { id, householdId }, include: withNames });
  // Anyone else gets "not found", not "forbidden": they needn't learn it exists.
  if (!check || (check.requesterId !== viewerId && check.targetId !== viewerId)) {
    throw new NotFoundError('Live check not found.');
  }
  return check;
}

/**
 * The checked person's phone sending where it is. 409 once the check is over
 * (or they've turned live checks off): the phone then stops.
 */
export async function reportLiveCheckFix(
  householdId: string,
  userId: string,
  input: LiveCheckFixInput,
  now: Date = new Date(),
): Promise<LiveCheckDTO> {
  const check = await prisma.locationCheck.findFirst({
    where: { id: input.id, householdId, targetId: userId },
    include: withNames,
  });
  if (!check) throw new NotFoundError('Live check not found.');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { locationSharing: true, liveChecks: true },
  });
  const consent = locationConsent(user ?? {});
  if (!isSharing(consent.sharing) || !consent.liveChecks) {
    await closeCheck(check, now, userId);
    throw new ConflictError('Live checks are off for you.');
  }
  if (liveCheckState(check, now) === 'ended') {
    await closeCheck(check, now, null);
    throw new ConflictError('This live check has ended.');
  }

  // A phone clock running fast can't date a fix in the future; an older fix
  // than the one stored (sent late) changes nothing.
  const at = input.at.getTime() > now.getTime() ? now : input.at;
  if (check.fixAt && at.getTime() <= check.fixAt.getTime()) return toDTO(check, now);
  const updated = await prisma.locationCheck.update({
    where: { id: check.id },
    data: {
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM ?? null,
      fixAt: at,
      answeredAt: check.answeredAt ?? now,
    },
    include: withNames,
  });
  return toDTO(updated, now);
}

/**
 * Stops a check early: the person checking, or the person checked (from the
 * notification), unless their sharing is required (parental controls).
 */
export async function stopLiveCheck(
  householdId: string,
  userId: string,
  id: string,
  now: Date = new Date(),
): Promise<LiveCheckDTO> {
  const check = await findForParty(householdId, userId, id);
  if (check.endedAt) return toDTO(check, now);
  if (check.targetId === userId && check.requesterId !== userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { locationSharing: true } });
    if (locationConsent(user ?? {}).sharing === 'required') {
      throw new ForbiddenError('This check can’t be stopped from here.');
    }
  }
  await closeCheck(check, now, userId);
  if (check.requesterId === userId) {
    // Their phone would stop at its next fix anyway; this ends the notification now.
    pushToMember(householdId, check.targetId, { type: 'live_check_stop', checkId: check.id }).catch((err) =>
      console.warn('[push] live_check_stop failed:', err),
    );
  }
  return toDTO(await findForParty(householdId, userId, id), now);
}
