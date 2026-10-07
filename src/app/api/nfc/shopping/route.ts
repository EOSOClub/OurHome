import { ok, parseBody, requireCreate, withAuth } from '@/server/api/http';
import { addTagItemToShopping } from '@/server/services/nfcService';
import { nfcTagRefSchema } from '@/lib/validation/nfc';

// "Add to shopping list" on the Android app's quick-scan notification: puts the
// tag's item on the tag's list (no duplicate if it's already there, unbought).
export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'shopping');
  const { tagId } = await parseBody(ctx.req, nfcTagRefSchema);
  return ok(await addTagItemToShopping(ctx.user.householdId!, ctx.user.id, tagId));
});
