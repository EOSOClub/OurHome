import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { restoreHousehold } from '@/server/services/householdRestore';
import { restoreHouseholdSchema } from '@/lib/validation/server';

// Restore a household from its export as a new household. Server admin only.
export const POST = withServerAdmin(async (ctx) => {
  const { data, name, headPassword } = await parseBody(ctx.req, restoreHouseholdSchema);
  const report = await restoreHousehold(ctx.user.id, data, { name: name || undefined, headPassword });
  return ok(report, { status: 201 });
});
