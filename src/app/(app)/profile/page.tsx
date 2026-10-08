import { requireUser } from '@/server/auth/session';
import { getProfileOverview } from '@/server/services/profileService';
import { getAppRelease } from '@/server/services/appDownloadService';
import { ProfileView } from '@/components/profile/profile-view';

export default async function ProfilePage() {
  const user = await requireUser();
  const overview = await getProfileOverview(user.id);

  return <ProfileView overview={overview} appRelease={getAppRelease()} />;
}
