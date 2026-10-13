import { requireFeature } from '@/server/auth/session';
import { lookAfterOverview } from '@/server/services/supervisionService';
import { LookAfterView } from '@/components/look-after/look-after-view';

export default async function LookAfterPage() {
  const user = await requireFeature('location');
  const initial = await lookAfterOverview(user.householdId!, user.id);
  return <LookAfterView initial={initial} />;
}
