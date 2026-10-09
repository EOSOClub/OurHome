import { fail, ok, parseQuery, withAuth } from '@/server/api/http';
import { pointsSummary } from '@/server/services/pointsService';
import { parseLocalDate } from '@/lib/taskCycles';
import { pointsSummaryQuerySchema } from '@/lib/validation/points';

// Every member's points for the day/week/month/year containing `date`
// (household time zone; default today). Everyone in the household sees it.
export const GET = withAuth(async ({ user, req }) => {
  const query = parseQuery(req, pointsSummaryQuerySchema);
  const date = query.date ? parseLocalDate(query.date) : undefined;
  if (date === null) return fail('Not a real date.', 400);
  return ok(await pointsSummary(user.householdId!, query.period, date));
});
