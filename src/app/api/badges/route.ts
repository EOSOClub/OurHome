import { ok, withAuth } from '@/server/api/http';
import { getNavBadges } from '@/server/services/navBadgeService';

// The nav's tab counts (Requests, Tasks), asked again as the member moves
// around; the website's layout only renders them on a full load.
export const GET = withAuth(async ({ user }) => {
  return ok(await getNavBadges({ id: user.id, householdId: user.householdId! }));
});
