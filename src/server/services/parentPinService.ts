import { prisma } from '@/server/db/prisma';
import { pushSync } from '@/server/services/pushService';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { isPinEventKind, pinEventText, type PinEventKind } from '@/lib/parentPin';
import type { PinEventInput } from '@/lib/validation/phone';

// The parent PIN on a supervised child's phone (parental controls): the phone
// keeps each PIN event (a wrong-PIN wait, a protected screen opened,
// Unlock Our Home) and sends it with its next check-in, which it makes at once
// (phoneStatusService.checkIn). Each adult who looks after the child gets a
// bell alert, which wakes their phone. Rules and text: src/lib/parentPin.ts.

/** The bell type for something the parent PIN did on a child's phone. */
export const PARENT_PIN_TYPE = 'parent_pin';

/** Events older than this are dropped: a phone back after a week off has nothing current to say. */
const PIN_EVENT_MAX_AGE_MS = 7 * 86_400_000;

/**
 * What the parent PIN did on [userId]'s phone. Each event alerts each
 * supervisor once (the phone sends it again until a check-in gets through,
 * so they're keyed by the phone's id for it); wrong-PIN waits once an hour
 * per supervisor, however many there were. Kinds this server doesn't know
 * (a newer app) and events from long ago are dropped. Each alert is dated
 * when it happened (never later than now).
 */
export async function reportPinEvents(
  householdId: string,
  userId: string,
  events: PinEventInput[],
  now: Date = new Date(),
): Promise<{ told: number }> {
  const current = events.filter((e) => isPinEventKind(e.kind) && now.getTime() - e.atMs <= PIN_EVENT_MAX_AGE_MS);
  if (current.length === 0) return { told: 0 };
  const [user, links] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, householdId }, select: { name: true } }),
    prisma.supervision.findMany({
      where: { householdId, supervisedId: userId },
      select: { supervisorId: true, supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
    }),
  ]);
  const supervisors = [
    ...new Set(
      links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role)).map((l) => l.supervisorId),
    ),
  ];
  if (!user || supervisors.length === 0) return { told: 0 };
  const at = (e: PinEventInput) => new Date(Math.min(e.atMs, now.getTime()));
  const keyFor = (e: PinEventInput, supervisorId: string) =>
    e.kind === 'wrong_pin'
      ? `pin:wrong_pin:${userId}:${at(e).toISOString().slice(0, 13)}:${supervisorId}`
      : `pin:${e.kind}:${userId}:${e.id}:${supervisorId}`;
  // One per key: several wrong-PIN waits in the same hour are one alert, dated at the first.
  const wanted = new Map<string, { e: PinEventInput; supervisorId: string }>();
  for (const e of [...current].sort((a, b) => a.atMs - b.atMs)) {
    for (const supervisorId of supervisors) {
      const key = keyFor(e, supervisorId);
      if (!wanted.has(key)) wanted.set(key, { e, supervisorId });
    }
  }
  const have = await prisma.notification.findMany({
    where: { householdId, dedupeKey: { in: [...wanted.keys()] } },
    select: { dedupeKey: true },
  });
  for (const n of have) if (n.dedupeKey) wanted.delete(n.dedupeKey);
  if (wanted.size === 0) return { told: 0 };
  await prisma.notification.createMany({
    data: [...wanted.entries()].map(([key, { e, supervisorId }]) => ({
      householdId,
      userId: supervisorId,
      type: PARENT_PIN_TYPE,
      ...pinEventText(e.kind as PinEventKind, user.name, e.screen),
      channel: 'in_app',
      subjectType: 'phone',
      subjectId: userId,
      dedupeKey: key,
      readAt: null,
      createdAt: at(e),
    })),
  });
  pushSync(householdId, { userIds: [...new Set([...wanted.values()].map((w) => w.supervisorId))] }, 'reminder');
  return { told: wanted.size };
}
