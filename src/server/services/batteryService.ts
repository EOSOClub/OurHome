import { prisma } from '@/server/db/prisma';
import { ConflictError } from '@/server/services/errors';
import { isSharing, locationConsent } from '@/lib/location';
import type { ReportBatteryInput } from '@/lib/validation/location';

// The phone's battery, shown next to its owner wherever presence is (the Map,
// Who's where). Kept on their MemberLocation row, so it goes when they stop
// sharing, like the rest of where they were. Sent with presence reports and
// live-check fixes, and on its own once an hour (reportBattery).

/**
 * Store a battery reading on the member's presence row, unless the row holds
 * a newer one. Nothing happens before the phone's first presence report: the
 * member isn't shown anywhere yet.
 */
export async function saveBattery(
  householdId: string,
  userId: string,
  battery: { pct: number; charging: boolean },
  at: Date,
  now: Date = new Date(),
): Promise<void> {
  // A phone clock running fast can't date a reading in the future.
  const readAt = at.getTime() > now.getTime() ? now : at;
  const row = await prisma.memberLocation.findUnique({
    where: { userId },
    select: { householdId: true, batteryAt: true },
  });
  if (!row || row.householdId !== householdId) return;
  if (row.batteryAt && row.batteryAt.getTime() >= readAt.getTime()) return;
  await prisma.memberLocation.update({
    where: { userId },
    data: { batteryPct: battery.pct, batteryCharging: battery.charging, batteryAt: readAt },
  });
}

/**
 * The phone's hourly reading. Refused (409) while the member doesn't share
 * their location: the app then stops sending.
 */
export async function reportBattery(
  householdId: string,
  userId: string,
  input: ReportBatteryInput,
  now: Date = new Date(),
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { locationSharing: true },
  });
  if (!isSharing(locationConsent(user ?? {}).sharing)) {
    throw new ConflictError('Location sharing is off for you.');
  }
  await saveBattery(householdId, userId, input, input.at, now);
}
