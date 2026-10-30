import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { countNewRequests } from '@/server/services/requestService';
import { countTasksToCheck } from '@/server/services/taskSubmissionService';
import { supervisedIds } from '@/server/services/supervisionService';

export interface NavBadges {
  /** Requests someone else made or changed since they last opened Requests. */
  requestsNew: number;
  /** Tasks children they look after sent for a check: the dashboard's "To check" line. */
  tasksToCheck: number;
}

/**
 * The counts on the nav's Requests and Tasks tabs. The layout renders them
 * once (layouts don't re-render on navigation), and the nav asks
 * `GET /api/badges` again as the member moves around.
 */
export async function getNavBadges(user: { id: string; householdId: string }): Promise<NavBadges> {
  const [features, supervised] = await Promise.all([
    getHouseholdFeatures(user.householdId),
    supervisedIds(user.householdId, user.id),
  ]);
  const [requestsNew, tasksToCheck] = await Promise.all([
    features.includes('requests') ? countNewRequests(user.householdId, user.id) : 0,
    features.includes('tasks') && supervised.size > 0 ? countTasksToCheck(user.householdId, user.id) : 0,
  ]);
  return { requestsNew, tasksToCheck };
}
