import { ok, parseBody, withAuth } from '@/server/api/http';
import { lookAfterOverview, ringPhone } from '@/server/services/supervisionService';
import { ringPhoneSchema } from '@/lib/validation/supervision';

// Ringing a supervised child's phone, loudly, even on silent. The service only
// lets an adult who supervises them ring.

// Who the viewer may ring, in the shape app builds from before required
// sharing ask for (they show their Ring list from it). New code reads
// GET /api/supervision/mine.
export const GET = withAuth(async (ctx) => {
  const mine = await lookAfterOverview(ctx.user.householdId!, ctx.user.id);
  return ok({ available: mine.canRing, ringable: mine.people.map(({ id, name }) => ({ id, name })) });
});

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, ringPhoneSchema);
  const ring = await ringPhone(ctx.user.householdId!, ctx.user, input.targetId);
  return ok({ rung: true, ring });
});
