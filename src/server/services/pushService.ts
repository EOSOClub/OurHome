import { prisma } from '@/server/db/prisma';
import { isPushConfigured, sendData } from '@/server/push/fcm';
import { membersWithAccess } from '@/server/services/permissionService';
import { can, type AccessAction, type AccessPage, type Permission } from '@/lib/permissions';

// Instant phone alerts for the Android app, via Firebase Cloud Messaging.
//
// Pushes carry no content, only "something changed" plus a reason. The phone
// then fetches from this server and posts its own notification, exactly as its
// hourly background check does. So names, amounts and request text never pass
// through Google, and the app's lock-screen rules still apply to everything.
// Off (a no-op) until FIREBASE_SERVICE_ACCOUNT is set.

/** Why the phones were woken; the app logs it. */
export type PushReason = 'request' | 'bug_report' | 'app_update' | 'reminder' | 'task' | 'map_places' | 'location' | 'usage';

/** Saves (or moves) this install's FCM token to the signed-in user. */
export async function registerDevice(
  householdId: string,
  userId: string,
  token: string,
): Promise<{ pushEnabled: boolean }> {
  await prisma.pushDevice.upsert({
    where: { token },
    // Same token, different account: the phone signed in as someone else.
    update: { householdId, userId },
    create: { householdId, userId, token, platform: 'android' },
  });
  return { pushEnabled: isPushConfigured() };
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
  if (!isPushConfigured()) return;
  sendSync(householdId, audience, reason).catch((err) => {
    console.warn(`[push] sync (${reason}) failed:`, err);
  });
}

/** Whether this server can push at all (Firebase set up). */
export function canPush(): boolean {
  return isPushConfigured();
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
    // A supervising adult ringing this child's phone (supervisionService).
    | { type: 'ring'; ringerId: string }
    // A supervisor looking at this child's app usage: send it now (supervisionService).
    | { type: 'usage_refresh' },
  opts: { ttlSec?: number } = {},
): Promise<number> {
  if (!isPushConfigured()) return 0;
  const devices = await prisma.pushDevice.findMany({
    where: { householdId, userId },
    select: { token: true },
  });
  if (devices.length === 0) return 0;
  const results = await Promise.all(
    devices.map(async (d) => ({ token: d.token, result: await sendData(d.token, data, opts.ttlSec) })),
  );
  const dead = results.filter((r) => r.result === 'invalid_token').map((r) => r.token);
  if (dead.length > 0) await prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
  const sent = results.filter((r) => r.result === 'sent').length;
  console.log(`[push] ${data.type}: ${sent}/${devices.length} device(s) reached`);
  return sent;
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

  const devices = await prisma.pushDevice.findMany({
    where: { householdId, userId: { in: [...ids] } },
    select: { token: true },
  });
  if (devices.length === 0) return;

  const results = await Promise.all(
    devices.map(async (d) => ({ token: d.token, result: await sendData(d.token, { type: 'sync', reason }) })),
  );
  const dead = results.filter((r) => r.result === 'invalid_token').map((r) => r.token);
  if (dead.length > 0) {
    await prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
  }
  const sent = results.filter((r) => r.result === 'sent').length;
  console.log(
    `[push] sync (${reason}): ${sent}/${devices.length} device(s) reached` +
      (dead.length > 0 ? `, ${dead.length} dead token(s) removed` : ''),
  );
}
