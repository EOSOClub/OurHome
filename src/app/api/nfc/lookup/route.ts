import { ok, parseQuery, withAuth } from '@/server/api/http';
import { lookupNfcTag } from '@/server/services/nfcService';
import { nfcLookupQuerySchema } from '@/lib/validation/nfc';

// The Android app resolves a tag it just scanned: set up or not, and which item.
export const GET = withAuth(async (ctx) => {
  const { tagId } = parseQuery(ctx.req, nfcLookupQuerySchema);
  return ok(await lookupNfcTag(ctx.user.householdId!, tagId));
});
