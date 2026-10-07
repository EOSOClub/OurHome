import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteEvent } from '@/server/services/calendarService';
import { recordOwner } from '@/server/services/permissionService';
import { eventIdSchema } from '@/lib/validation/calendar';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { id } = await parseBody(ctx.req, eventIdSchema);
  await requireModify(ctx, 'calendar', 'delete', await recordOwner.event(householdId, id));
  await deleteEvent(householdId, ctx.user.id, id);
  return ok({ id });
});
