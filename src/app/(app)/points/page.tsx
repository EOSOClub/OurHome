import { requireFeature } from '@/server/auth/session';
import { pointsSummary } from '@/server/services/pointsService';
import { PointsView } from '@/components/points/points-view';

export default async function PointsPage() {
  const user = await requireFeature('points');
  const summary = await pointsSummary(user.householdId!, 'week');
  return <PointsView initialSummary={summary} userId={user.id} isHead={user.role === 'head'} />;
}
