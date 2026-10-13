import { prisma } from '@/server/db/prisma';
import { pushSync } from '@/server/services/pushService';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { sharingMode } from '@/lib/location';
import { freshestPhone, phoneAlertText, phoneProblems, type PhoneProblem } from '@/lib/phoneHealth';
import type { PhoneCheckInInput } from '@/lib/validation/phone';

// Phone check-ins and the alerts they feed (parental controls). Every phone
// with the app checks in about hourly; for a supervised child, the 15-minute
// sweep (and each check-in) turns a quiet phone, or location switched off
// while required, into a bell notification for that child's supervisors only.
// The alert goes away by itself once the problem does. Rules: src/lib/phoneHealth.ts.

/** The bell type, and the key every alert row carries (one per problem, child and supervisor). */
export const PHONE_ALERT_TYPE = 'phone_alert';
const alertKey = (problem: PhoneProblem, kidId: string, supervisorId: string) =>
  `phone:${problem}:${kidId}:${supervisorId}`;

/** A phone checking in. Then its member's alerts are brought up to date at once. */
export async function checkIn(
  householdId: string,
  userId: string,
  input: PhoneCheckInInput,
  now: Date = new Date(),
): Promise<void> {
  const data = {
    householdId,
    userId,
    lastSeenAt: now,
    appVersion: input.appVersion ?? null,
    deviceName: input.deviceName ?? null,
    locationAlways: input.locationAlways,
    notifications: input.notifications,
    usageAccess: input.usageAccess ?? null,
  };
  // Same install, someone else signed in: the row moves to them.
  await prisma.phoneStatus.upsert({
    where: { installId: input.installId },
    update: data,
    create: { installId: input.installId, ...data },
  });
  await refreshPhoneAlerts(householdId, now, [userId]);
}

/** Each child's freshest phone and what's wrong with it, for the Map card. */
export async function phoneSummaries(
  householdId: string,
  kids: { id: string; locationSharing: string | null; shareAppUsage?: boolean | null }[],
  now: Date = new Date(),
): Promise<Map<string, { lastSeenAt: string; deviceName: string | null; problems: PhoneProblem[] }>> {
  const out = new Map<string, { lastSeenAt: string; deviceName: string | null; problems: PhoneProblem[] }>();
  if (kids.length === 0) return out;
  const [phones, locationOn] = await Promise.all([
    prisma.phoneStatus.findMany({
      where: { householdId, userId: { in: kids.map((k) => k.id) } },
      select: { userId: true, lastSeenAt: true, locationAlways: true, usageAccess: true, deviceName: true },
    }),
    isFeatureEnabled(householdId, 'location').catch(() => true),
  ]);
  for (const kid of kids) {
    const phone = freshestPhone(phones.filter((p) => p.userId === kid.id));
    if (!phone) continue;
    out.set(kid.id, {
      lastSeenAt: phone.lastSeenAt.toISOString(),
      deviceName: phone.deviceName,
      problems: phoneProblems(
        phone,
        { sharing: sharingMode(kid.locationSharing), usageShared: kid.shareAppUsage === true, locationOn },
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
      supervised: { select: { id: true, name: true, role: true, locationSharing: true, shareAppUsage: true } },
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
