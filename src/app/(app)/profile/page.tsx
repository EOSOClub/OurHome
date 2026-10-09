import { requireUser } from '@/server/auth/session';
import { getProfileOverview, listHouseholdProfiles } from '@/server/services/profileService';
import { getAppRelease } from '@/server/services/appDownloadService';
import { ProfileView } from '@/components/profile/profile-view';

export default async function ProfilePage() {
  const user = await requireUser();
  const [overview, household] = await Promise.all([
    getProfileOverview(user.id),
    user.householdId ? listHouseholdProfiles(user.householdId) : Promise.resolve([]),
  ]);

  return <ProfileView overview={overview} household={household} appRelease={getAppRelease()} />;
}
