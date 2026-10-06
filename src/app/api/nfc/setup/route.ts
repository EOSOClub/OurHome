import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { setupNfcTag } from '@/server/services/nfcService';
import { nfcSetupSchema } from '@/lib/validation/nfc';

// Set up (or re-bind) a tag from the Android app: bind it to an existing item or
// create the item. Needs inventory:write — tag setup is part of managing stock,
// so members can do it without settings:manage (the web Settings mapping).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'inventory:write');
  const input = await parseBody(ctx.req, nfcSetupSchema);
  return ok(await setupNfcTag(ctx.user.householdId!, ctx.user.id, input), { status: 201 });
});
