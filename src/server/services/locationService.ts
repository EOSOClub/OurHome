import { prisma } from '@/server/db/prisma';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/services/errors';
import {
  REMINDER_FRESH_MS,
  homeReminderDue,
  isSharing,
  locationConsent,
  nextPresence,
  type LocationConsent,
  type PresenceState,
} from '@/lib/location';
import { canChangeOwnSharing } from '@/lib/permissions';
import { closeExpiredLiveChecks, endLiveChecksOn } from '@/server/services/liveCheckService';
import { myTasksDueToday } from '@/server/services/dashboardService';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import type { MemberPresenceDTO, PresenceReportDTO } from '@/lib/types';
import type { ReportPresenceInput, UpdateLocationConsentInput } from '@/lib/validation/location';

// A member's own location consent (Profile → Location), and presence: where
// the members who share are, from their Android app's geofences. Off until a
// member turns it on; turning it off deletes what was stored about them.
// Live checks are in liveCheckService.

const consentSelect = { locationSharing: true, liveChecks: true } as const;

export async function getLocationConsent(userId: string): Promise<LocationConsent> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: consentSelect });
  if (!user) throw new NotFoundError('User not found');
  return locationConsent(user);
}

export async function updateLocationConsent(
  userId: string,
  input: UpdateLocationConsentInput,
): Promise<LocationConsent> {
  const current = await getLocationConsent(userId);
  if (input.sharing !== undefined && input.sharing !== current.sharing && !canChangeOwnSharing(current.sharing)) {
    throw new ForbiddenError('Location sharing is required for you, so it can’t be turned off here.');
  }
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      locationSharing: input.sharing,
      liveChecks: input.liveChecks,
    },
    select: consentSelect,
  });
  const consent = locationConsent(user);
  // Stopped sharing or allowing checks: a check running on them ends now.
  const allowedBefore = isSharing(current.sharing) && current.liveChecks;
  if (allowedBefore && (!isSharing(consent.sharing) || !consent.liveChecks)) {
    await endLiveChecksOn(userId);
  }
  // Stopped sharing: nothing about where they were stays behind.
  if (!isSharing(consent.sharing)) {
    await prisma.memberLocation.deleteMany({ where: { userId } });
  }
  return consent;
}

/**
 * The phone arrived at or left a map place. Updates the member's presence
 * (nextPresence decides whether the report is news) and, when they've just
 * arrived at a store with lists still to buy, answers with the reminder for
 * the phone to show. Refused (409) while they don't share: the app then stops
 * watching. 404 for a place that's gone: the app re-syncs its places.
 */
export async function reportPresence(
  householdId: string,
  userId: string,
  input: ReportPresenceInput,
  now: Date = new Date(),
): Promise<PresenceReportDTO> {
  const consent = await getLocationConsent(userId);
  if (!isSharing(consent.sharing)) {
    throw new ConflictError('Location sharing is off for you.');
  }
  const place = await prisma.mapPlace.findFirst({
    where: { id: input.placeId, householdId },
    select: { id: true, name: true, kind: true, shoppingListIds: true },
  });
  if (!place) throw new NotFoundError('Map place not found.');

  // A phone clock running fast can't push a report into the future.
  const at = input.at.getTime() > now.getTime() ? now : input.at;
  const stored = await prisma.memberLocation.findUnique({ where: { userId } });
  const change = nextPresence(
    stored ? { state: stored.state as PresenceState, placeId: stored.placeId ?? null, at: stored.at } : null,
    { placeId: place.id, transition: input.transition, at },
  );
  if (!change) return { reminder: null, home: null };

  const data = {
    householdId,
    state: change.next.state,
    placeId: change.next.placeId,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    accuracyM: input.accuracyM ?? null,
    at: change.next.at,
  };
  await prisma.memberLocation.upsert({ where: { userId }, update: data, create: { userId, ...data } });

  // Reminders only for a real arrival the phone reported in time.
  const fresh = now.getTime() - at.getTime() <= REMINDER_FRESH_MS;
  if (!change.arrived || !fresh) return { reminder: null, home: null };
  if (place.kind === 'home') {
    return { reminder: null, home: await homeReminder(householdId, userId, stored?.homeReminderAt ?? null, now) };
  }
  if (place.kind !== 'store' || place.shoppingListIds.length === 0) return { reminder: null, home: null };
  return { reminder: await storeReminder(householdId, place), home: null };
}

/**
 * "You're home: 3 chores due": their own tasks due today or overdue, while
 * the household uses Tasks, at most every few hours (HOME_REMINDER_GAP_MS).
 * Null when there's nothing due or it's too soon.
 */
async function homeReminder(
  householdId: string,
  userId: string,
  lastRemindedAt: Date | null,
  now: Date,
): Promise<PresenceReportDTO['home']> {
  if (!homeReminderDue(lastRemindedAt, now)) return null;
  if (!(await getHouseholdFeatures(householdId)).includes('tasks')) return null;
  const due = await myTasksDueToday(householdId, userId, now);
  if (due.count === 0) return null;
  await prisma.memberLocation.update({ where: { userId }, data: { homeReminderAt: now } });
  return due;
}

/** The store's linked lists that still have something to buy; null if none. */
async function storeReminder(
  householdId: string,
  place: { id: string; name: string; shoppingListIds: string[] },
): Promise<PresenceReportDTO['reminder']> {
  const lists = await prisma.shoppingList.findMany({
    where: { householdId, id: { in: place.shoppingListIds } },
    select: { id: true, name: true, _count: { select: { items: { where: { purchased: false } } } } },
  });
  const open = lists
    .filter((l) => l._count.items > 0)
    .map((l) => ({ id: l.id, name: l.name, openItems: l._count.items }));
  return open.length ? { placeId: place.id, placeName: place.name, lists: open } : null;
}

/**
 * Where everyone who shares their location is. Members who don't share, and
 * those whose phone hasn't reported yet, aren't listed. Someone at a place is
 * shown at the place, never at their exact spot inside it; someone away comes
 * with the point their phone was at when they left (the map's last known point).
 */
export async function listPresence(householdId: string): Promise<MemberPresenceDTO[]> {
  // A check that ran out while nobody looked hands its last fix over first.
  await closeExpiredLiveChecks(householdId);
  const [rows, places] = await Promise.all([
    prisma.memberLocation.findMany({
      where: { householdId },
      include: { user: { select: { name: true, locationSharing: true, householdId: true } } },
    }),
    prisma.mapPlace.findMany({ where: { householdId }, select: { id: true, name: true, kind: true } }),
  ]);
  const placeById = new Map(places.map((p) => [p.id, p]));
  return rows
    // Belt and braces: a row left by someone who stopped sharing or moved
    // household is never shown.
    .filter((r) => r.user.householdId === householdId && isSharing(locationConsent(r.user).sharing))
    .map((r) => {
      const place = r.state === 'place' && r.placeId ? placeById.get(r.placeId) ?? null : null;
      const point =
        !place && r.lat != null && r.lng != null
          ? { lat: r.lat, lng: r.lng, accuracyM: r.accuracyM ?? null, at: (r.pointAt ?? r.at).toISOString() }
          : null;
      return {
        userId: r.userId,
        name: r.user.name,
        state: place ? 'place' : 'away',
        place,
        since: r.at.toISOString(),
        point,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
