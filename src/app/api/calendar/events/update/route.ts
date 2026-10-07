import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updateEvent } from '@/server/services/calendarService';
import { recordOwner } from '@/server/services/permissionService';
import { updateEventSchema } from '@/lib/validation/calendar';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateEventSchema);
  await requireModify(ctx, 'calendar', 'edit', await recordOwner.event(householdId, input.id));
  const event = await updateEvent(householdId, ctx.user.id, input);
  return ok(event);
});
