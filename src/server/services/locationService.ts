import { prisma } from '@/server/db/prisma';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';
import { locationConsent, type LocationConsent } from '@/lib/location';
import { canChangeOwnSharing } from '@/lib/permissions';
import type { UpdateLocationConsentInput } from '@/lib/validation/location';

// A member's own location consent (Profile → Location). Off until they turn
// it on. Nothing reads a location yet: presence comes with the Android app's
// geofencing, live checks after that (vault: Location and Presence).

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
  return locationConsent(user);
}
