import { requireUser } from '@/server/auth/session';
import { lookAfterOverview } from '@/server/services/supervisionService';
import { LookAfterView } from '@/components/look-after/look-after-view';

// People you look after works with Location off (decided 2026-11-08): only
// Ring and location sharing need Location, and the view hides those itself.
export default async function LookAfterPage() {
  const user = await requireUser();
  const initial = await lookAfterOverview(user.householdId!, user.id);
  return <LookAfterView initial={initial} />;
}
