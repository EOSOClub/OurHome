import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { restoreHousehold } from '@/server/services/householdRestore';
import { restoreHouseholdSchema } from '@/lib/validation/server';

// A whole household's export (years of activity included): far above the
// everyday cap, but still bounded. Only the server admin can send it.
const RESTORE_BODY_MAX_BYTES = 64 * 1024 * 1024;

// Restore a household from its export as a new household. Server admin only.
export const POST = withServerAdmin(async (ctx) => {
  const { data, name, headPassword } = await parseBody(ctx.req, restoreHouseholdSchema, RESTORE_BODY_MAX_BYTES);
  const report = await restoreHousehold(ctx.user.id, data, { name: name || undefined, headPassword });
  return ok(report, { status: 201 });
});
