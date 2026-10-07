import {
  ok,
  parseBody,
  requireAnyAccess,
  requireCreate,
  withAuth,
} from '@/server/api/http';
import { setupNfcTag } from '@/server/services/nfcService';
import { nfcSetupSchema } from '@/lib/validation/nfc';

// Set up (or re-bind) a tag from the Android app: bind it to an existing item or
// create the item. Tag setup is part of managing stock, so anyone with Inventory
// access may bind a tag (no settings:manage needed); creating the item as well
// needs Inventory "Add".
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, nfcSetupSchema);
  if (input.newItem) await requireCreate(ctx, 'inventory');
  else await requireAnyAccess(ctx, 'inventory');
  return ok(await setupNfcTag(ctx.user.householdId!, ctx.user.id, input), { status: 201 });
});
