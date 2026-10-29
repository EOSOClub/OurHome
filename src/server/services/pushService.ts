import { randomUUID } from 'node:crypto';
import { prisma } from '@/server/db/prisma';
import { isPushConfigured, sendData, type PushPriority } from '@/server/push/fcm';
import { deliverToStreams, hasStreams, isStreamConnected } from '@/server/push/streamHub';
import { membersWithAccess } from '@/server/services/permissionService';
import { can, type AccessAction, type AccessPage, type Permission } from '@/lib/permissions';

// Instant phone alerts for the Android app, via Firebase Cloud Messaging.
//
// Pushes carry no content, only "something changed" plus a reason. The phone
// then fetches from this server and posts its own notification, exactly as its
// hourly background check does. So names, amounts and request text never pass
// through Google, and the app's lock-screen rules still apply to everything.
// Firebase is off (a no-op) until FIREBASE_SERVICE_ACCOUNT is set.
//
// Phones that "Stay connected" also get every message down their open stream
// (streamHub), with or without Firebase. Each message carries a random `id`,
// so a phone that gets it both ways acts on it once.

/** Why the phones were woken; the app logs it. */
export type PushReason =
  | 'request'
  | 'bug_report'
  | 'app_update'
  | 'reminder'
  | 'task'
  | 'map_places'
  | 'location'
  | 'usage'
  | 'supervision';

/**
 * Reasons the phone handles without posting anything: its geofences, its
 * sharing state, its usage report, whether it must Stay connected. Sent at
 * normal priority, because Firebase demotes an installation's high-priority
 * messages when they keep ending without a visible notification (fcm.ts), and
 * that would slow its rings and live checks. The rest usually end in a
 * notification and stay high.
 */
const SILENT_REASONS: ReadonlySet<PushReason> = new Set(['map_places', 'location', 'usage', 'supervision']);

export function syncPriority(reason: PushReason): PushPriority {
  return SILENT_REASONS.has(reason) ? 'normal' : 'high';
}

/** A phone that hasn't re-registered for this long is treated as gone (the app re-registers daily). */
export const PUSH_DEVICE_STALE_MS = 60 * 24 * 60 * 60_000;

/**
 * Saves (or moves) this installation's FCM token to the signed-in user. [installId]
 * (newer apps) ties it to the phone, so a token Firebase later calls dead
 * marks that phone ([forgetDeadTokens]); registering clears that mark.
 */
export async function registerDevice(
  householdId: string,
  userId: string,
  token: string,
  installId?: string,
): Promise<{ pushEnabled: boolean }> {
  await prisma.pushDevice.upsert({
    where: { token },
    // Same token, different account: the phone signed in as someone else.
    // updatedAt set even when nothing else changed: it's how a live phone
    // is told from a stale one (forgetStaleDevices).
    update: { householdId, userId, updatedAt: new Date(), ...(installId ? { installId } : {}) },
    create: { householdId, userId, token, platform: 'android', installId: installId ?? null },
  });
  if (installId) {
    await prisma.phoneStatus.updateMany({ where: { installId, userId }, data: { pushGoneAt: null } });
  }
  return { pushEnabled: isPushConfigured() };
}

/**
 * Drops tokens Firebase called dead (the app uninstalled, or its data
 * cleared), and marks their phones: a supervised child's phone that then goes
 * quiet is reported as OurHome removed (lib/phoneHealth.ts).
 */
async function forgetDeadTokens(devices: { token: string; installId: string | null }[], now: Date = new Date()) {
  if (devices.length === 0) return;
  await prisma.pushDevice.deleteMany({ where: { token: { in: devices.map((d) => d.token) } } });
  const installs = devices.map((d) => d.installId).filter((id): id is string => Boolean(id));
  if (installs.length > 0) {
    await prisma.phoneStatus.updateMany({ where: { installId: { in: installs } }, data: { pushGoneAt: now } });
  }
}

/**
 * A quiet supervised phone (its Stay connected stream closed and didn't come
 * back): a silent `ping` through Firebase. A phone that's on and online
 * checks in; Firebase's answer can say the app is gone ('gone'). 'none':
 * Firebase is off, or this installation has no token tied to it.
 */
export async function pingInstall(
  householdId: string,
  userId: string,
  installId: string,
): Promise<'sent' | 'gone' | 'failed' | 'none'> {
  if (!isPushConfigured()) return 'none';
  const devices = await prisma.pushDevice.findMany({
    where: { householdId, userId, installId },
    select: { token: true, installId: true },
  });
  if (devices.length === 0) return 'none';
  const message = { type: 'ping', id: randomUUID() };
  const results = await Promise.all(
    devices.map(async (d) => ({ device: d, result: await sendData(d.token, message, 600, 'normal') })),
  );
  const dead = results.filter((r) => r.result === 'invalid_token').map((r) => r.device);
  await forgetDeadTokens(dead);
  if (dead.length === devices.length) return 'gone';
  return results.some((r) => r.result === 'sent') ? 'sent' : 'failed';
}

/**
 * Drops tokens no phone has re-registered for [PUSH_DEVICE_STALE_MS]: the app
 * was uninstalled or its data cleared without Firebase saying so yet. From the
 * reminder sweep. Returns how many went.
 */
export async function forgetStaleDevices(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.pushDevice.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - PUSH_DEVICE_STALE_MS) } },
  });
  if (count > 0) console.log(`[push] ${count} stale device(s) forgotten`);
  return count;
}

/** Forgets this install on sign-out. Only the owner's own token is removed. */
export async function unregisterDevice(userId: string, token: string): Promise<void> {
  await prisma.pushDevice.deleteMany({ where: { token, userId } });
}

export interface PushAudience {
  /** Specific people. Nulls are ignored (e.g. an unassigned request). */
  userIds?: (string | null | undefined)[];
  /** Everyone in the household holding this permission (e.g. the head). */
  permission?: Permission;
  /** Everyone whose page-access grid grants this (e.g. media request approvers). */
  access?: { page: AccessPage; action: AccessAction };
  /** Every member's phone (e.g. a new app version). */
  everyone?: boolean;
}

/**
 * Wakes the audience's phones so they re-check now. Fire-and-forget: it never
 * throws and never delays the caller's response, and a failed push only means
 * the phone catches up on its next hourly check.
 */
export function pushSync(householdId: string, audience: PushAudience, reason: PushReason): void {
  if (!isPushConfigured() && !hasStreams(householdId)) return;
  sendSync(householdId, audience, reason).catch((err) => {
    console.warn(`[push] sync (${reason}) failed:`, err);
  });
}

/**
 * Whether a push can reach anyone: always with Firebase; without it, only
 * phones that Stay connected. [householdId] alone: anyone in the household;
 * with [userId]: that member's phones.
 */
export function canPush(householdId?: string, userId?: string): boolean {
  if (isPushConfigured()) return true;
  if (!householdId) return false;
  return userId ? isStreamConnected(householdId, userId) : hasStreams(householdId);
}

/**
 * Sends one message straight to one member's phones and waits for Firebase's
 * answer: live checks and rings need to know at once whether a phone was
 * reached. Like the sync pushes it carries no names or places, only ids.
 * Returns how many phones were reached (0 when push is off or they have none).
 */
export async function pushToMember(
  householdId: string,
  userId: string,
  data:
    | { type: 'live_check' | 'live_check_stop'; checkId: string }
    // A supervising adult ringing this child's phone (supervisionService);
    // the phone reports back on ringId.
    | { type: 'ring'; ringerId: string; ringId: string }
    // A supervisor looking at this child's app usage: send it now (supervisionService).
    | { type: 'usage_refresh' }
    // The member asked for a test notification on their own phones (Profile).
    | { type: 'test' },
  // priority: 'normal' for anything the phone handles without a notification (fcm.ts).
  opts: { ttlSec?: number; priority?: PushPriority } = {},
): Promise<number> {
  const message = { ...data, id: randomUUID() };
  // A phone reached both ways counts twice; callers only ask "anyone?".
  const streamed = deliverToStreams(householdId, [userId], message);
  if (!isPushConfigured()) {
    console.log(`[push] ${data.type}: ${streamed} connected phone(s) reached, no Firebase`);
    return streamed;
  }
  const devices = await prisma.pushDevice.findMany({
    where: { householdId, userId },
    select: { token: true, installId: true },
  });
  const results = await Promise.all(
    devices.map(async (d) => ({ device: d, result: await sendData(d.token, message, opts.ttlSec, opts.priority) })),
  );
  await forgetDeadTokens(results.filter((r) => r.result === 'invalid_token').map((r) => r.device));
  const sent = results.filter((r) => r.result === 'sent').length;
  console.log(`[push] ${data.type}: ${sent}/${devices.length} device(s) reached, ${streamed} connected`);
  return sent + streamed;
}

/** One test per member per this long, so the button can't be used to flood Firebase. */
export const TEST_PUSH_COOLDOWN_MS = 10_000;
const lastTestAt = new Map<string, number>();

/**
 * "Send me a test notification" (the app's Profile): a high-priority push to
 * the member's own phones, which post a visible notification (so it also
 * keeps Firebase's priority healthy). reached: phones Firebase accepted it for
 * plus connected phones; 0 says why in firebase / connected.
 */
export async function sendTestPush(
  householdId: string,
  userId: string,
  now: number = Date.now(),
): Promise<{ reached: number; firebase: boolean; connected: boolean; tooSoon: boolean }> {
  const firebase = isPushConfigured();
  const connected = isStreamConnected(householdId, userId);
  const last = lastTestAt.get(userId);
  if (last !== undefined && now - last < TEST_PUSH_COOLDOWN_MS) return { reached: 0, firebase, connected, tooSoon: true };
  lastTestAt.set(userId, now);
  const reached = await pushToMember(householdId, userId, { type: 'test' }, { ttlSec: 300 });
  return { reached, firebase, connected, tooSoon: false };
}

async function sendSync(householdId: string, audience: PushAudience, reason: PushReason) {
  const ids = new Set(audience.userIds?.filter((id): id is string => Boolean(id)));
  if (audience.everyone) {
    const devices = await prisma.pushDevice.findMany({ where: { householdId }, select: { userId: true } });
    for (const d of devices) ids.add(d.userId);
  }
  if (audience.permission) {
    const members = await prisma.user.findMany({
      where: { householdId },
      select: { id: true, role: true },
    });
    for (const m of members) if (can(m.role, audience.permission)) ids.add(m.id);
  }
  if (audience.access) {
    const { page, action } = audience.access;
    for (const id of await membersWithAccess(householdId, page, action)) ids.add(id);
  }
  if (ids.size === 0) return;

  const message = { type: 'sync', reason, id: randomUUID() };
  const streamed = deliverToStreams(householdId, ids, message);
  if (!isPushConfigured()) {
    if (streamed > 0) console.log(`[push] sync (${reason}): ${streamed} connected phone(s) reached, no Firebase`);
    return;
  }

  const devices = await prisma.pushDevice.findMany({
    where: { householdId, userId: { in: [...ids] } },
    select: { token: true, installId: true },
  });
  if (devices.length === 0 && streamed === 0) return;

  const results = await Promise.all(
    devices.map(async (d) => ({
      device: d,
      result: await sendData(d.token, message, undefined, syncPriority(reason)),
    })),
  );
  const dead = results.filter((r) => r.result === 'invalid_token').map((r) => r.device);
  await forgetDeadTokens(dead);
  const sent = results.filter((r) => r.result === 'sent').length;
  console.log(
    `[push] sync (${reason}): ${sent}/${devices.length} device(s) reached, ${streamed} connected` +
      (dead.length > 0 ? `, ${dead.length} dead token(s) removed` : ''),
  );
}
