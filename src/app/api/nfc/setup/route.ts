import {
  ok,
  parseBody,
  requireAnyAccess,
  requireCreate,
  requireModify,
  withAuth,
} from '@/server/api/http';
import { ForbiddenError } from '@/server/services/errors';
import { limitTagSetup, setupNfcTag } from '@/server/services/nfcService';
import { nfcSetupSchema } from '@/lib/validation/nfc';

// Set up (or re-bind) a tag from the Android app: bind it to an existing item or
// create the item. Tag setup is part of managing stock, so anyone with Inventory
// access may bind a tag (no settings:manage needed); creating the item as well
// needs Inventory "Add".
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, nfcSetupSchema);
  if (input.newItem) await requireCreate(ctx, 'inventory');
  else await requireAnyAccess(ctx, 'inventory');
  // What a tag does (its scan action, its list, the room it opens) is changed
  // with Inventory "Edit others'", as on /api/nfc/tags/settings. Without it,
  // setup binds the tag and leaves those alone.
  const mayChangeTag = await requireModify(ctx, 'inventory', 'edit', null).then(
    () => true,
    (err: unknown) => {
      if (err instanceof ForbiddenError) return false;
      throw err;
    },
  );
  const householdId = ctx.user.householdId!;
  const allowed = await limitTagSetup(householdId, input, mayChangeTag);
  return ok(await setupNfcTag(householdId, ctx.user.id, allowed), { status: 201 });
});
