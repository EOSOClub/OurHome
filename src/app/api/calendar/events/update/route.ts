import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateEvent } from '@/server/services/calendarService';
import { updateEventSchema } from '@/lib/validation/calendar';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'calendar:write');
  const input = await parseBody(ctx.req, updateEventSchema);
  const event = await updateEvent(ctx.user.householdId!, ctx.user.id, input);
  return ok(event);
});
