import { ok, parseBody, withAuth } from '@/server/api/http';
import { voidAward } from '@/server/services/pointsService';
import { voidAwardSchema } from '@/lib/validation/points';

// Head only (pointsService.voidAward): strike a points entry from the totals,
// keeping it in the ledger with the reason.
export const POST = withAuth(async ({ user, req }) => {
  const input = await parseBody(req, voidAwardSchema);
  return ok(await voidAward(user.householdId!, { id: user.id, role: user.role }, input));
});
