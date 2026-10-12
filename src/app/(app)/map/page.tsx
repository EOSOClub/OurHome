import { requireFeature } from '@/server/auth/session';
import { can } from '@/lib/permissions';
import { isSharing } from '@/lib/location';
import { listMapPlaces } from '@/server/services/mapPlaceService';
import { getLocationConsent, listPresence } from '@/server/services/locationService';
import { MapView } from '@/components/map/map-view';

export default async function MapPage() {
  const user = await requireFeature('location');
  const [places, presence, consent] = await Promise.all([
    listMapPlaces(user.householdId!),
    listPresence(user.householdId!),
    getLocationConsent(user.id),
  ]);
  return (
    <MapView
      initialPlaces={places}
      initialPresence={presence}
      viewerSharing={isSharing(consent.sharing)}
      canManagePlaces={can(user.role, 'settings:manage')}
    />
  );
}
