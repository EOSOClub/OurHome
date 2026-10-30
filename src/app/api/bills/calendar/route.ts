import { ok, parseBody, requireCreate, requireFeatureOn, withAuth } from '@/server/api/http';
import { addBillToCalendar } from '@/server/services/billCalendarService';
import { billIdSchema } from '@/lib/validation/bills';

// Put a bill on the calendar, on its due date. Like adding an event, it needs
// Calendar on and Calendar Add access (the path only checks Bills).
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  await requireFeatureOn(ctx, 'calendar');
  await requireCreate(ctx, 'calendar');
  const { id } = await parseBody(ctx.req, billIdSchema);
  await addBillToCalendar(householdId, ctx.user.id, id);
  return ok({ id });
});
