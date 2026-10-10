import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { setHouseholdFeatures } from '@/server/services/serverAdminService';
import { setHouseholdFeaturesSchema } from '@/lib/validation/server';

// Choose which features a household uses. Server admin only.
export const POST = withServerAdmin(async (ctx) => {
  const { id, enabled } = await parseBody(ctx.req, setHouseholdFeaturesSchema);
  await setHouseholdFeatures(ctx.user.id, id, enabled);
  return ok({ id, enabled });
});
