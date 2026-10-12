import { requireUser } from '@/server/auth/session';
import { getProfileOverview, listHouseholdProfiles } from '@/server/services/profileService';
import { getAppRelease } from '@/server/services/appDownloadService';
import { getLocationConsent } from '@/server/services/locationService';
import { ProfileView } from '@/components/profile/profile-view';

export default async function ProfilePage() {
  const user = await requireUser();
  const [overview, household, location] = await Promise.all([
    getProfileOverview(user.id),
    user.householdId ? listHouseholdProfiles(user.householdId) : Promise.resolve([]),
    getLocationConsent(user.id),
  ]);

  return (
    <ProfileView overview={overview} household={household} location={location} appRelease={getAppRelease()} />
  );
}
