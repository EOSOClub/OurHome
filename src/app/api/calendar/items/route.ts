import { ok, parseQuery, withAuth } from '@/server/api/http';
import { listChoreItems } from '@/server/services/calendarItemsService';
import { listEventsQuerySchema } from '@/lib/validation/calendar';

// Chores (and later other pages' dates) shown on the calendar, read-only.
export const GET = withAuth(async (ctx) => {
  const { start, end } = parseQuery(ctx.req, listEventsQuerySchema);
  const chores = await listChoreItems(ctx.user.householdId!, start, end);
  return ok(chores);
});
