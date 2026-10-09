import { fail, ok, parseQuery, withAuth } from '@/server/api/http';
import { listAwards } from '@/server/services/pointsService';
import { parseLocalDate } from '@/lib/taskCycles';
import { pointsAwardsQuerySchema } from '@/lib/validation/points';

// The points ledger (newest first), voided entries included and flagged.
export const GET = withAuth(async ({ user, req }) => {
  const query = parseQuery(req, pointsAwardsQuerySchema);
  const date = query.date ? parseLocalDate(query.date) : undefined;
  if (date === null) return fail('Not a real date.', 400);
  return ok(
    await listAwards(user.householdId!, {
      userId: query.userId,
      period: query.period,
      date,
      limit: query.limit,
    }),
  );
});
