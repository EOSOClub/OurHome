import { ok, parseBody, withAuth } from '@/server/api/http';
import { ringOverview, ringPhone } from '@/server/services/supervisionService';
import { ringPhoneSchema } from '@/lib/validation/supervision';

// Ringing a supervised child's phone, loudly, even on silent. Anyone may ask
// who they can ring; the service only lets a supervising adult ring.
export const GET = withAuth(async (ctx) => ok(await ringOverview(ctx.user.householdId!, ctx.user.id)));

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, ringPhoneSchema);
  await ringPhone(ctx.user.householdId!, ctx.user, input.targetId);
  return ok({ rung: true });
});
