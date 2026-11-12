import { getAccess, ok, parseBody, requireCreate, requireFeatureOn, withAuth } from '@/server/api/http';
import { removeBillFromCalendar } from '@/server/services/billCalendarService';
import { billIdSchema } from '@/lib/validation/bills';
import { canModify } from '@/lib/permissions';

// Take a bill off the calendar: the same access that put it there.
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  await requireFeatureOn(ctx, 'calendar');
  await requireCreate(ctx, 'calendar');
  const { id } = await parseBody(ctx.req, billIdSchema);
  // An old same-named copy is someone's ordinary event: it is only touched
  // with the access that would let the caller delete that event by hand.
  const access = await getAccess(ctx);
  const mayDelete = (ownerId: string | null) => canModify(access.calendar, 'delete', ownerId, ctx.user.id);
  await removeBillFromCalendar(householdId, ctx.user.id, id, mayDelete);
  return ok({ id });
});
