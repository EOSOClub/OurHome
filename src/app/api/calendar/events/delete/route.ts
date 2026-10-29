import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteEvent } from '@/server/services/calendarService';
import { recordOwner } from '@/server/services/permissionService';
import { deleteEventSchema } from '@/lib/validation/calendar';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, deleteEventSchema);
  const { id } = input;
  await requireModify(ctx, 'calendar', 'delete', await recordOwner.event(householdId, id));
  await deleteEvent(householdId, ctx.user.id, input);
  return ok({ id });
});
