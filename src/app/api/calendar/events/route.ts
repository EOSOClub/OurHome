import {
  ok,
  parseBody,
  parseQuery,
  requireCreate,
  withAuth,
} from '@/server/api/http';
import { createEvent, listOccurrences } from '@/server/services/calendarService';
import {
  createEventSchema,
  listEventsQuerySchema,
} from '@/lib/validation/calendar';

export const GET = withAuth(async (ctx) => {
  const { start, end } = parseQuery(ctx.req, listEventsQuerySchema);
  const occurrences = await listOccurrences(ctx.user.householdId!, start, end);
  return ok(occurrences);
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'calendar');
  const input = await parseBody(ctx.req, createEventSchema);
  const event = await createEvent(ctx.user.householdId!, ctx.user.id, input);
  return ok(event, { status: 201 });
});
