import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { setHouseholdDisabled } from '@/server/services/serverAdminService';
import { setHouseholdDisabledSchema } from '@/lib/validation/server';

// Turn a household off (members signed out and refused) or back on. Server admin only.
export const POST = withServerAdmin(async (ctx) => {
  const { id, disabled } = await parseBody(ctx.req, setHouseholdDisabledSchema);
  await setHouseholdDisabled(ctx.user.id, id, disabled);
  return ok({ id, disabled });
});
