import { ok, parseQuery, withAuth } from '@/server/api/http';
import { listActivity } from '@/server/services/activityService';
import { activityQuerySchema } from '@/lib/validation/activity';

// The household activity log, newest first, filtered by area and/or person;
// page on with `before` = the previous page's `nextBefore`.
export const GET = withAuth(async ({ user, req }) => {
  const query = parseQuery(req, activityQuerySchema);
  return ok(
    await listActivity(user.householdId!, {
      area: query.area,
      actorId: query.userId,
      before: query.before,
      limit: query.limit,
    }),
  );
});
