import { getAccess, ok, parseBody, requireCreate, requireFeatureOn, withAuth } from '@/server/api/http';
import { addBillToCalendar } from '@/server/services/billCalendarService';
import { billIdSchema } from '@/lib/validation/bills';
import { canModify } from '@/lib/permissions';

// Put a bill on the calendar, on its due date. Like adding an event, it needs
// Calendar on and Calendar Add access (the path only checks Bills).
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  await requireFeatureOn(ctx, 'calendar');
  await requireCreate(ctx, 'calendar');
  const { id } = await parseBody(ctx.req, billIdSchema);
  // An old same-named copy is someone's ordinary event: it is only touched
  // with the access that would let the caller edit that event by hand.
  const access = await getAccess(ctx);
  const mayEdit = (ownerId: string | null) => canModify(access.calendar, 'edit', ownerId, ctx.user.id);
  await addBillToCalendar(householdId, ctx.user.id, id, mayEdit);
  return ok({ id });
});
