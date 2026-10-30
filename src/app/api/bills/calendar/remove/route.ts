import { ok, parseBody, requireCreate, requireFeatureOn, withAuth } from '@/server/api/http';
import { removeBillFromCalendar } from '@/server/services/billCalendarService';
import { billIdSchema } from '@/lib/validation/bills';

// Take a bill off the calendar: the same access that put it there.
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  await requireFeatureOn(ctx, 'calendar');
  await requireCreate(ctx, 'calendar');
  const { id } = await parseBody(ctx.req, billIdSchema);
  await removeBillFromCalendar(householdId, ctx.user.id, id);
  return ok({ id });
});
