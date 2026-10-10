import { ok, parseBody, withAuth } from '@/server/api/http';
import { deleteHousehold } from '@/server/services/householdDataService';
import { deleteHouseholdSchema } from '@/lib/validation/server';

// Permanently delete a turned-off household and everything in it. Server admin only.
export const POST = withAuth(async (ctx) => {
  const { id, confirmName } = await parseBody(ctx.req, deleteHouseholdSchema);
  return ok({ id, deleted: await deleteHousehold(ctx.user.id, id, confirmName) });
});
