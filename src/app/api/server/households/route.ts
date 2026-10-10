import { ok, parseBody, withAuth } from '@/server/api/http';
import { assertServerAdmin, createHousehold, listHouseholds } from '@/server/services/serverAdminService';
import { createHouseholdSchema } from '@/lib/validation/server';

// Households on this server (server admin only).
export const GET = withAuth(async (ctx) => {
  await assertServerAdmin(ctx.user.id);
  return ok(await listHouseholds(ctx.user.id));
});

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, createHouseholdSchema);
  return ok(await createHousehold(ctx.user.id, input), { status: 201 });
});
