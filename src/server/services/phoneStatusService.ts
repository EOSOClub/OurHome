import { prisma } from '@/server/db/prisma';
import { pingInstall, pushSync } from '@/server/services/pushService';
import { saveBattery } from '@/server/services/batteryService';
import { phoneBlocks, type PhoneBlock } from '@/server/services/appBlockService';
import { phoneLimits, reportLimitsReached, type PhoneLimit } from '@/server/services/appLimitService';
import { phoneSchedules, type PhoneSchedule } from '@/server/services/appScheduleService';
import { phoneExtraTime, phonePointsRule, type PhonePointsRule } from '@/server/services/pointsTimeService';
import { connectedInstalls } from '@/server/push/streamHub';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { sharingMode } from '@/lib/location';
import {
  PHONE_QUICK_QUIET_MS,
  freshestPhone,
  lastWordAt,
  phoneAlertText,
  phoneProblems,
  phoneRules,
  setupChecks,
  setupRequired,
  type PhoneProblem,
  type PhoneRuleColumns,
  type PhoneSetupChecks,
} from '@/lib/phoneHealth';
import type { PhoneSetupDTO } from '@/lib/types';
import type { PhoneCheckInInput, PhoneStatusInput } from '@/lib/validation/phone';

/** What a supervised member's phone alerts are judged on (their User row). */
export const SUPERVISED_SELECT = {
  locationSharing: true,
  shareAppUsage: true,
  requireKeepRunning: true,
  requirePreventUninstall: true,
  requireBatteryUnrestricted: true,
} as const;

// Phone check-ins and the alerts they feed (parental controls). Every phone
// with the app checks in about hourly (every 15 minutes while its app usage is
// shared); for a supervised child, the 15-minute sweep (and each check-in)
// turns a quiet phone, a low battery, or location switched off while
// required, into a bell notification for that child's supervisors only.
// The alert goes away by itself once the problem does. Rules: src/lib/phoneHealth.ts.

/** The bell type, and the key every alert row carries (one per problem, child and supervisor). */
export const PHONE_ALERT_TYPE = 'phone_alert';
const alertKey = (problem: PhoneProblem, kidId: string, supervisorId: string) =>
  `phone:${problem}:${kidId}:${supervisorId}`;

/**
 * A phone checking in. Then its member's alerts are brought up to date at
 * once. Answers whether the phone must Stay connected: while an adult looks
 * after its member, so they can always be reached (the switch is locked on,
 * and the app starts it again after Android's Stop). Then also the apps their
 * supervisors blocked, which the phone covers with its "blocked" screen, and
 * their daily limits and schedules, the extra minutes on those limits around
 * today, and what a point buys (null: they can't buy time). The limits it used
 * up today go to their supervisors.
 */
export async function checkIn(
  householdId: string,
  userId: string,
  input: PhoneCheckInInput,
  now: Date = new Date(),
): Promise<{
  stayConnectedRequired: boolean;
  blockedApps: PhoneBlock[];
  appLimits: PhoneLimit[];
  schedules: PhoneSchedule[];
  extraTime: { day: string; minutes: number }[];
  pointsForTime: PhonePointsRule | null;
}> {
  const data = {
    householdId,
    userId,
    lastSeenAt: now,
    appVersion: input.appVersion ?? null,
    deviceName: input.deviceName ?? null,
    locationAlways: input.locationAlways,
    notifications: input.notifications,
    usageAccess: input.usageAccess ?? null,
    // The phone's clock: never later than now, so a fast clock can't look fresh.
    lastPushAt: input.lastPushAtMs ? new Date(Math.min(input.lastPushAtMs, now.getTime())) : null,
    lastPushVia: input.lastPushAtMs ? (input.lastPushVia ?? null) : null,
    batteryUnrestricted: input.batteryUnrestricted ?? null,
    standbyBucket: input.standbyBucket ?? null,
    stayConnected: input.stayConnected ?? null,
    closeGuard: input.closeGuard ?? null,
    uninstallGuard: input.uninstallGuard ?? null,
    ...(await emergencyData(input)),
    ...statusData(input.status, now),
    // Like the status: sent only while an adult looks after them.
    ...(input.alwaysAllowed ? { alwaysAllowed: [...new Set(input.alwaysAllowed)] } : {}),
    // Its last word before Android switches it off; any other word clears it.
    shutdownAt: input.shuttingDown ? now : null,
    // It's here, so whatever Firebase said about an old token no longer counts.
    pushGoneAt: null,
  };
  // Same install, someone else signed in: the row moves to them.
  await prisma.phoneStatus.upsert({
    where: { installId: input.installId },
    update: data,
    create: { installId: input.installId, ...data },
  });
  // Its battery keeps the Map's reading fresh too; saveBattery skips anyone not sharing where they are.
  const battery = input.status?.battery;
  if (battery != null) {
    await saveBattery(householdId, userId, { pct: battery, charging: input.status?.charging === true }, now, now);
  }
  await refreshPhoneAlerts(householdId, now, [userId]);
  const supervised = await isSupervised(householdId, userId);
  if (supervised && input.limitsReached) await reportLimitsReached(householdId, userId, input.limitsReached, now);
  return {
    stayConnectedRequired: supervised,
    // Blocks, limits and schedules only count while someone looks after them (they're deleted when nobody does).
    blockedApps: supervised ? await phoneBlocks(householdId, userId) : [],
    appLimits: supervised ? await phoneLimits(householdId, userId) : [],
    schedules: supervised ? await phoneSchedules(householdId, userId) : [],
    extraTime: supervised ? await phoneExtraTime(householdId, userId, now) : [],
    pointsForTime: supervised ? await phonePointsRule(householdId, userId) : null,
  };
}

/**
 * The emergency unlock's milestone as stored. The phone sends each milestone
 * once; between them it sends only when the unlock ends, so the last one is
 * kept while that's sent. "unlocked" is kept while the uninstall guard is
 * still off, so the alert stays until a parent has put it back.
 */
async function emergencyData(input: PhoneCheckInInput): Promise<{ emergencyUnlockStage?: string | null }> {
  if (input.emergencyUnlockStage) return { emergencyUnlockStage: input.emergencyUnlockStage };
  if (input.emergencyUnlockReadyAtMs) return {};
  if (input.uninstallGuard === false) {
    const stored = await prisma.phoneStatus.findUnique({
      where: { installId: input.installId },
      select: { emergencyUnlockStage: true },
    });
    if (stored?.emergencyUnlockStage === 'unlocked') return {};
  }
  return { emergencyUnlockStage: null };
}

/** A phone's status as stored; nothing when it sent none (an older app, or nobody looks after them). */
function statusData(status: PhoneStatusInput | undefined, now: Date) {
  if (!status) return {};
  return {
    batteryPct: status.battery ?? null,
    batteryCharging: status.charging ?? null,
    network: status.network ?? null,
    signalLevel: status.signal ?? null,
    statusAt: now,
  };
}

/**
 * A phone's Stay connected stream opened (with its status) or closed. Both
 * count as hearing from it ([lastWordAt]). After a close, unless it's back:
 * a quiet Firebase ping a few minutes on, whose answer can say OurHome is
 * gone from it (pushService.pingInstall), and the alerts checked again once
 * it counts as quiet ([PHONE_QUICK_QUIET_MS]), instead of waiting for the
 * 15-minute sweep. Only for a member an adult looks after.
 */
export async function recordStream(
  householdId: string,
  userId: string,
  installId: string,
  event: { opened: true; status?: PhoneStatusInput } | { opened: false },
  now: Date = new Date(),
): Promise<void> {
  clearWatch(installId);
  await prisma.phoneStatus.updateMany({
    where: { installId, userId, householdId },
    data: {
      streamAt: now,
      ...(event.opened ? { ...statusData(event.status, now), shutdownAt: null, pushGoneAt: null } : {}),
    },
  });
  if (event.opened || !(await isSupervised(householdId, userId))) return;
  // Already back (the server ends each stream every 30 minutes, and the phone reconnects at once).
  if (connectedInstalls(householdId).has(installId)) return;
  clearWatch(installId);
  watches.set(installId, [
    setTimeout(() => void probe(householdId, userId, installId), PING_AFTER_MS),
    setTimeout(() => {
      watches.delete(installId);
      refreshPhoneAlerts(householdId, new Date(), [userId]).catch((err) =>
        console.warn('[phone] checking a quiet phone failed; the sweep will:', err),
      );
    }, PHONE_QUICK_QUIET_MS + 60_000),
  ]);
  for (const timer of watches.get(installId) ?? []) timer.unref?.();
}

/** How long after a stream closes the phone is pinged through Firebase, unless it's back. */
export const PING_AFTER_MS = 8 * 60_000;

/** Follow-ups waiting per install, dropped when its stream opens again. In memory: one server process. */
const globalWatch = globalThis as unknown as { __ourhomePhoneWatch?: Map<string, ReturnType<typeof setTimeout>[]> };
const watches = (globalWatch.__ourhomePhoneWatch ??= new Map());

function clearWatch(installId: string) {
  for (const timer of watches.get(installId) ?? []) clearTimeout(timer);
  watches.delete(installId);
}

async function probe(householdId: string, userId: string, installId: string) {
  if (connectedInstalls(householdId).has(installId)) return;
  try {
    const result = await pingInstall(householdId, userId, installId);
    console.log(`[phone] quiet phone pinged: ${result}`);
  } catch (err) {
    console.warn('[phone] pinging a quiet phone failed:', err);
  }
}

/** Tests only: drop every waiting follow-up. */
export function clearPhoneWatches(): void {
  for (const id of [...watches.keys()]) clearWatch(id);
}

/**
 * What [userId]'s phone must have on, for its Set up this phone checklist:
 * nothing while nobody looks after them. Otherwise notifications always (the
 * household's alerts and the ring's Stop need them), location all the time
 * while their sharing is required and the household uses Location, Usage
 * access while their app usage is shared, and the protections their
 * supervisors require.
 */
export async function phoneSetup(householdId: string, userId: string): Promise<PhoneSetupDTO> {
  const [supervised, user, locationOn] = await Promise.all([
    isSupervised(householdId, userId),
    prisma.user.findFirst({ where: { id: userId, householdId }, select: SUPERVISED_SELECT }),
    isFeatureEnabled(householdId, 'location').catch(() => true),
  ]);
  if (!supervised || !user) {
    return {
      supervised: false,
      required: {
        notifications: false,
        location: false,
        usageAccess: false,
        keepRunning: false,
        preventUninstall: false,
        batteryUnrestricted: false,
      },
    };
  }
  return {
    supervised: true,
    required: setupRequired({
      sharing: sharingMode(user.locationSharing),
      usageShared: user.shareAppUsage === true,
      locationOn,
      rules: phoneRules(user),
    }),
  };
}

/** Whether an adult looks after [userId] right now (both roles still fit). */
async function isSupervised(householdId: string, userId: string): Promise<boolean> {
  const links = await prisma.supervision.findMany({
    where: { householdId, supervisedId: userId },
    select: { supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
  });
  return links.some((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role));
}

/**
 * A child's freshest phone, for "People you look after": its last check-in,
 * what's wrong with it, when an instant alert last reached it, and whether it
 * uses Stay connected (and is connected to this server right now).
 */
export interface PhoneSummary {
  lastSeenAt: string;
  deviceName: string | null;
  problems: PhoneProblem[];
  lastPushAt: string | null;
  stayConnected: boolean;
  connected: boolean;
  /** What it last said about each step of Set up this phone. */
  checks: PhoneSetupChecks;
  /** The apps it never blocks (package names). */
  alwaysAllowed: string[];
}

/** Each child's freshest phone and what's wrong with it, for the Map card. */
export async function phoneSummaries(
  householdId: string,
  kids: ({ id: string; locationSharing: string | null; shareAppUsage?: boolean | null } & Partial<PhoneRuleColumns>)[],
  now: Date = new Date(),
): Promise<Map<string, PhoneSummary>> {
  const out = new Map<string, PhoneSummary>();
  if (kids.length === 0) return out;
  const [phones, locationOn] = await Promise.all([
    prisma.phoneStatus.findMany({
      where: { householdId, userId: { in: kids.map((k) => k.id) } },
      select: {
        userId: true,
        installId: true,
        lastSeenAt: true,
        locationAlways: true,
        notifications: true,
        usageAccess: true,
        batteryUnrestricted: true,
        deviceName: true,
        lastPushAt: true,
        stayConnected: true,
        closeGuard: true,
        uninstallGuard: true,
        emergencyUnlockStage: true,
        streamAt: true,
        batteryPct: true,
        batteryCharging: true,
        network: true,
        signalLevel: true,
        statusAt: true,
        shutdownAt: true,
        pushGoneAt: true,
        alwaysAllowed: true,
      },
    }),
    isFeatureEnabled(householdId, 'location').catch(() => true),
  ]);
  const connected = connectedInstalls(householdId);
  for (const kid of kids) {
    const phone = freshestPhone(phones.filter((p) => p.userId === kid.id));
    if (!phone) continue;
    out.set(kid.id, {
      // Its stream counts too, so "last seen" matches when the quiet alert counts from.
      lastSeenAt: lastWordAt(phone).toISOString(),
      deviceName: phone.deviceName,
      lastPushAt: phone.lastPushAt?.toISOString() ?? null,
      stayConnected: phone.stayConnected === true,
      connected: connected.has(phone.installId),
      checks: setupChecks(phone),
      alwaysAllowed: phone.alwaysAllowed,
      problems: phoneProblems(
        { ...phone, connected: connected.has(phone.installId) },
        {
          sharing: sharingMode(kid.locationSharing),
          usageShared: kid.shareAppUsage === true,
          locationOn,
          rules: phoneRules(kid),
        },
        now,
      ),
    });
  }
  return out;
}

/**
 * Bring the household's phone alerts in line with now: one unread-able row
 * per problem, child and supervisor; rows whose problem has gone (or whose
 * supervisor no longer supervises) are removed. [onlyUserIds]: just these
 * children (a check-in), instead of the whole household (the sweep).
 */
export async function refreshPhoneAlerts(householdId: string, now: Date = new Date(), onlyUserIds?: string[]): Promise<void> {
  const links = await prisma.supervision.findMany({
    where: { householdId, ...(onlyUserIds ? { supervisedId: { in: onlyUserIds } } : {}) },
    select: {
      supervisorId: true,
      supervisor: { select: { role: true } },
      supervised: { select: { id: true, name: true, role: true, ...SUPERVISED_SELECT } },
    },
  });
  const valid = links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role));
  const kids = [...new Map(valid.map((l) => [l.supervised.id, l.supervised])).values()];
  const summaries = await phoneSummaries(householdId, kids, now);

  const wanted = new Map<string, { kid: (typeof kids)[number]; problem: PhoneProblem; supervisorId: string }>();
  for (const link of valid) {
    for (const problem of summaries.get(link.supervised.id)?.problems ?? []) {
      wanted.set(alertKey(problem, link.supervised.id, link.supervisorId), {
        kid: link.supervised,
        problem,
        supervisorId: link.supervisorId,
      });
    }
  }

  const existing = await prisma.notification.findMany({
    where: { householdId, type: PHONE_ALERT_TYPE, ...(onlyUserIds ? { subjectId: { in: onlyUserIds } } : {}) },
    select: { id: true, dedupeKey: true },
  });
  const have = new Set(existing.map((n) => n.dedupeKey));
  const stale = existing.filter((n) => !n.dedupeKey || !wanted.has(n.dedupeKey)).map((n) => n.id);
  if (stale.length) await prisma.notification.deleteMany({ where: { id: { in: stale } } });

  const fresh = [...wanted.entries()].filter(([key]) => !have.has(key));
  if (fresh.length === 0) return;
  await prisma.notification.createMany({
    data: fresh.map(([key, { kid, problem, supervisorId }]) => ({
      householdId,
      userId: supervisorId,
      type: PHONE_ALERT_TYPE,
      ...phoneAlertText(problem, kid.name),
      channel: 'in_app',
      subjectType: 'phone',
      subjectId: kid.id,
      dedupeKey: key,
      readAt: null,
      createdAt: now,
    })),
  });
  pushSync(householdId, { userIds: [...new Set(fresh.map(([, a]) => a.supervisorId))] }, 'reminder');
}
