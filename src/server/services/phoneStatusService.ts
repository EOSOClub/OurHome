import { prisma } from '@/server/db/prisma';
import { pingInstall, pushSync } from '@/server/services/pushService';
import { saveBattery } from '@/server/services/batteryService';
import { phoneBlocks, type PhoneBlock } from '@/server/services/appBlockService';
import { phoneLimits, reportLimitsReached, type PhoneLimit } from '@/server/services/appLimitService';
import { phoneSchedules, type PhoneSchedule } from '@/server/services/appScheduleService';
import { reportPinEvents } from '@/server/services/parentPinService';
import { phoneExtraTime, phonePointsRule, type PhonePointsRule } from '@/server/services/pointsTimeService';
import { connectedInstalls } from '@/server/push/streamHub';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { sharingMode } from '@/lib/location';
import { WEB_FILTER_INFO, webFilterOf } from '@/lib/webFilter';
import { createAllOnce } from '@/server/services/errors';
import {
  PHONE_PROBLEMS,
  PHONE_QUICK_QUIET_MS,
  SILENT_PROBLEMS,
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
  webFilter: true,
} as const;

// Phone check-ins and the alerts they feed (parental controls). Every phone
// with the app checks in about hourly (every 15 minutes while its app usage is
// shared); for a supervised child, the 15-minute sweep (and each check-in)
// turns a quiet phone, a low battery, or location switched off while
// required, into a bell notification for that child's supervisors only.
// The alert goes away by itself once the problem does. Rules: src/lib/phoneHealth.ts.

/** The bell type, and the key every alert row carries (one per problem, child, and supervisor). */
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
 * today, what a point buys (null: they can't buy time), and the web filter's
 * hostname (null: none), whose Private DNS setting the phone then keeps them
 * out of. The limits it used up today, and what the parent PIN did there,
 * go to their supervisors.
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
  webFilter: string | null;
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
    // Left out when it couldn't read it: what it said last still holds.
    ...(input.privateDns ? { privateDns: input.privateDns } : {}),
    // The phone's clock: never later than now, so a fast clock can't look fresh.
    lastPushAt: input.lastPushAtMs ? new Date(Math.min(input.lastPushAtMs, now.getTime())) : null,
    lastPushVia: input.lastPushAtMs ? (input.lastPushVia ?? null) : null,
    batteryUnrestricted: input.batteryUnrestricted ?? null,
    standbyBucket: input.standbyBucket ?? null,
    stayConnected: input.stayConnected ?? null,
    closeGuard: input.closeGuard ?? null,
    uninstallGuard: input.uninstallGuard ?? null,
    ...(await emergencyData(input, userId)),
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
  if (supervised && input.pinEvents?.length) await reportPinEvents(householdId, userId, input.pinEvents, now);
  const filter = supervised
    ? webFilterOf((await prisma.user.findUnique({ where: { id: userId }, select: { webFilter: true } }))?.webFilter)
    : null;
  return {
    stayConnectedRequired: supervised,
    // Blocks, limits and schedules only count while someone looks after them (they're deleted when nobody does).
    blockedApps: supervised ? await phoneBlocks(householdId, userId) : [],
    appLimits: supervised ? await phoneLimits(householdId, userId) : [],
    schedules: supervised ? await phoneSchedules(householdId, userId) : [],
    extraTime: supervised ? await phoneExtraTime(householdId, userId, now) : [],
    pointsForTime: supervised ? await phonePointsRule(householdId, userId) : null,
    webFilter: filter ? WEB_FILTER_INFO[filter].hostname : null,
  };
}

/**
 * The emergency-unlock milestone as stored. The phone sends each milestone
 * once; between them, it sends only the time the unlocking ends, so the last
 * one is kept while that time is sent. "unlocked" is kept while the guard
 * against uninstalling is still off, so the alert stays until a parent has
 * put it back. Only for the member it was kept for: on a shared device
 * someone else signed in on, the last member's milestone isn't theirs, so it
 * starts fresh (P7, owner 2026-11-08); a milestone the phone sends now still
 * counts, whoever is signed in.
 */
async function emergencyData(input: PhoneCheckInInput, userId: string): Promise<{ emergencyUnlockStage?: string | null }> {
  if (input.emergencyUnlockStage) return { emergencyUnlockStage: input.emergencyUnlockStage };
  if (!input.emergencyUnlockReadyAtMs && input.uninstallGuard !== false) return { emergencyUnlockStage: null };
  const stored = await prisma.phoneStatus.findUnique({
    where: { installId: input.installId },
    select: { userId: true, emergencyUnlockStage: true },
  });
  if (stored && stored.userId !== userId) return { emergencyUnlockStage: null };
  if (input.emergencyUnlockReadyAtMs) return {};
  if (stored?.emergencyUnlockStage === 'unlocked') return {};
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
  if (event.opened) {
    // Back: an alert raised while it was away (a restart, a dropped network)
    // goes now, not at the next sweep or check-in. Only when there is one.
    const alert = await prisma.notification.findFirst({
      where: { householdId, type: PHONE_ALERT_TYPE, subjectId: userId },
      select: { id: true },
    });
    if (alert) await refreshPhoneAlerts(householdId, now, [userId]);
    return;
  }
  if (!(await isSupervised(householdId, userId))) return;
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

/** How long after a stream closes, the phone is pinged through Firebase, unless it's back. */
export const PING_AFTER_MS = 8 * 60_000;

/** Follow-ups waiting per installation, dropped when its stream opens again. In memory: one server process. */
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
 * nothing while nobody looks after them. Otherwise, notifications always (the
 * household's alerts and the ring's Stop need them), and location all the
 * time while their sharing is required and the household uses Location. It
 * also needs Usage access while their app usage is shared, the web filter
 * while one is chosen (with what to enter for it), and the protections their
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
        webFilter: false,
        keepRunning: false,
        preventUninstall: false,
        batteryUnrestricted: false,
      },
      webFilter: null,
    };
  }
  const filter = webFilterOf(user.webFilter);
  return {
    supervised: true,
    required: setupRequired({
      sharing: sharingMode(user.locationSharing),
      usageShared: user.shareAppUsage === true,
      locationOn,
      rules: phoneRules(user),
      webFilter: filter,
    }),
    webFilter: filter
      ? { filter, label: WEB_FILTER_INFO[filter].label, hostname: WEB_FILTER_INFO[filter].hostname }
      : null,
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
  /**
   * While it's quiet: what its last report showed wrong, under the rules as
   * they are now (P5, owner 2026-11-08), shown after the silence. Empty
   * while it's heard from: then [problems] says it all.
   */
  lastKnown: PhoneProblem[];
  lastPushAt: string | null;
  stayConnected: boolean;
  connected: boolean;
  /** What it last said about each step of Set up this phone. */
  checks: PhoneSetupChecks;
  /** The apps it never blocks (package names). */
  alwaysAllowed: string[];
  /**
   * Every device they're signed in on, freshest first, each judged on its own
   * (P3, owner 2026-11-08): a quiet main phone shows beside a tablet that
   * keeps checking in. A supervisor can forget one they no longer use.
   */
  devices: DeviceSummary[];
}

/** One of a child's devices on their card: when it was last heard from and what's wrong with it. */
export interface DeviceSummary {
  installId: string;
  deviceName: string | null;
  lastSeenAt: string;
  problems: PhoneProblem[];
  /** While it's quiet: what its last report showed wrong (as [PhoneSummary.lastKnown]). */
  lastKnown: PhoneProblem[];
}

type SummaryKid = {
  id: string;
  locationSharing: string | null;
  shareAppUsage?: boolean | null;
  webFilter?: string | null;
} & Partial<PhoneRuleColumns>;

/** Each child's freshest phone and what's wrong with it, for the Map card. */
export async function phoneSummaries(
  householdId: string,
  kids: SummaryKid[],
  now: Date = new Date(),
): Promise<Map<string, PhoneSummary>> {
  const judged = await judgePhones(householdId, kids, now);
  return new Map([...judged].map(([kidId, j]) => [kidId, j.summary]));
}

/** What the alerts need: each child's summary, and each of their devices judged on its own. */
interface PhoneJudgement {
  summary: PhoneSummary;
  devices: DeviceJudgement[];
}

interface DeviceJudgement {
  problems: PhoneProblem[];
  /** It used Stay connected and the server started too recently to tell whether it's reconnecting. */
  mayStillStream: boolean;
  /**
   * What its last report shows wrong under the rules as they are now, its
   * silence aside. While it's quiet only these alerts are kept: one whose
   * requirement was since turned off still goes.
   */
  lastKnown: Set<PhoneProblem>;
}

async function judgePhones(
  householdId: string,
  kids: SummaryKid[],
  now: Date,
): Promise<Map<string, PhoneJudgement>> {
  const out = new Map<string, PhoneJudgement>();
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
        privateDns: true,
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
  const sinceBoot = now.getTime() - serverStartedAt.getTime();
  const justStarted = sinceBoot >= 0 && sinceBoot < STREAM_BOOT_GRACE_MS;
  for (const kid of kids) {
    const kidPhones = phones.filter((p) => p.userId === kid.id);
    const phone = freshestPhone(kidPhones);
    if (!phone) continue;
    const webFilter = webFilterOf(kid.webFilter);
    const expect = {
      sharing: sharingMode(kid.locationSharing),
      usageShared: kid.shareAppUsage === true,
      locationOn,
      rules: phoneRules(kid),
      webFilter,
    };
    // Each device on its own, freshest first.
    const judged = [...kidPhones]
      .sort((a, b) => lastWordAt(b).getTime() - lastWordAt(a).getTime())
      .map((p) => {
        const problems = phoneProblems({ ...p, connected: connected.has(p.installId) }, expect, now);
        const lastKnown = phoneProblems({ ...p, connected: true }, expect, now).filter((x) => !SILENT_PROBLEMS.has(x));
        const quiet = problems.some((x) => SILENT_PROBLEMS.has(x));
        return {
          row: p,
          problems,
          lastKnown,
          quiet,
          mayStillStream: justStarted && p.stayConnected === true && p.streamAt != null,
        };
      });
    const own = judged.find((d) => d.row === phone)!;
    const { problems, lastKnown, quiet } = own;
    out.set(kid.id, {
      summary: {
        // Its stream counts too, so "last seen" matches when the quiet alert counts from.
        lastSeenAt: lastWordAt(phone).toISOString(),
        deviceName: phone.deviceName,
        lastPushAt: phone.lastPushAt?.toISOString() ?? null,
        stayConnected: phone.stayConnected === true,
        connected: connected.has(phone.installId),
        checks: setupChecks(phone, webFilter),
        alwaysAllowed: phone.alwaysAllowed,
        problems,
        lastKnown: quiet ? lastKnown : [],
        devices: judged.map((d) => ({
          installId: d.row.installId,
          deviceName: d.row.deviceName,
          lastSeenAt: lastWordAt(d.row).toISOString(),
          problems: d.problems,
          lastKnown: d.quiet ? d.lastKnown : [],
        })),
      },
      devices: judged.map((d) => ({
        problems: d.problems,
        mayStillStream: d.mayStillStream,
        lastKnown: new Set(d.lastKnown),
      })),
    });
  }
  return out;
}

/**
 * After the server starts, a phone that held its Stay connected stream isn't
 * connected again yet: streams live in memory, the close was never noted, and
 * the phone's wait between tries is up to 5 minutes (plus 90 s to notice a
 * dead connection). Until then its silence isn't news either way.
 */
export const STREAM_BOOT_GRACE_MS = 7 * 60_000;

/** When this server process started (Node's performance.timeOrigin). */
let serverStartedAt = new Date(performance.timeOrigin);

/** Tests only: when the server started. */
export function setServerStartedAt(at: Date): void {
  serverStartedAt = at;
}

/**
 * Bring the household's phone alerts in line with now: one unread-able row
 * per problem, child, and supervisor; rows whose problem has gone (or whose
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
  const judged = await judgePhones(householdId, kids, now);

  const wanted = new Map<string, { kid: (typeof kids)[number]; problem: PhoneProblem; supervisorId: string }>();
  // Rows left as they are though their problem isn't judged now: only a
  // fresh report that says a problem is gone takes its alert away, so it's
  // never deleted and then raised (and pushed) again as new.
  const kept = new Set<string>();
  for (const link of valid) {
    const kidId = link.supervised.id;
    const keep = (problem: PhoneProblem) => kept.add(alertKey(problem, kidId, link.supervisorId));
    // Every device they're signed in on, each on its own (P3, owner
    // 2026-11-08): a quiet main phone is said while a tablet checks in. One
    // alert per problem, whichever devices have it.
    for (const device of judged.get(kidId)?.devices ?? []) {
      const silent = device.problems.some((p) => SILENT_PROBLEMS.has(p));
      if (silent && device.mayStillStream) {
        // Just restarted: it may be reconnecting. Nothing raised, nothing
        // dropped, except an alert whose requirement was turned off.
        PHONE_PROBLEMS.filter((p) => SILENT_PROBLEMS.has(p) || device.lastKnown.has(p)).forEach(keep);
        continue;
      }
      // While it's quiet only the silence is said; what it said before isn't
      // known to be fixed, so those alerts stay, as long as the rules still ask
      // for what they're about (turning a requirement off still clears its alert).
      if (silent) device.lastKnown.forEach(keep);
      for (const problem of device.problems) {
        wanted.set(alertKey(problem, kidId, link.supervisorId), {
          kid: link.supervised,
          problem,
          supervisorId: link.supervisorId,
        });
      }
    }
  }

  const existing = await prisma.notification.findMany({
    where: { householdId, type: PHONE_ALERT_TYPE, ...(onlyUserIds ? { subjectId: { in: onlyUserIds } } : {}) },
    select: { id: true, dedupeKey: true },
  });
  const have = new Set(existing.map((n) => n.dedupeKey));
  const stale = existing
    .filter((n) => !n.dedupeKey || (!wanted.has(n.dedupeKey) && !kept.has(n.dedupeKey)))
    .map((n) => n.id);
  if (stale.length) await prisma.notification.deleteMany({ where: { id: { in: stale } } });

  const fresh = [...wanted.entries()].filter(([key]) => !have.has(key));
  if (fresh.length === 0) return;
  // A check-in and the sweep can write the same alert at the same moment.
  await createAllOnce(
    fresh.map(([key, { kid, problem, supervisorId }]) => ({
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
    (data) => prisma.notification.createMany({ data }),
    (data) => prisma.notification.create({ data }),
  );
  pushSync(householdId, { userIds: [...new Set(fresh.map(([, a]) => a.supervisorId))] }, 'reminder');
}
