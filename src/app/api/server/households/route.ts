import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { createHousehold, listHouseholds } from '@/server/services/serverAdminService';
import { createHouseholdSchema } from '@/lib/validation/server';

// Households on this server (server admin only).
export const GET = withServerAdmin(async (ctx) => {
  return ok(await listHouseholds(ctx.user.id));
});

export const POST = withServerAdmin(async (ctx) => {
  const input = await parseBody(ctx.req, createHouseholdSchema);
  return ok(await createHousehold(ctx.user.id, input), { status: 201 });
});
