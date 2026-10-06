import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteEvent } from '@/server/services/calendarService';
import { eventIdSchema } from '@/lib/validation/calendar';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'calendar:write');
  const { id } = await parseBody(ctx.req, eventIdSchema);
  await deleteEvent(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
