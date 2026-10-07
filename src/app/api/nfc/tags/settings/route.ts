import { ok, parseBody, requireAnyAccess, withAuth } from '@/server/api/http';
import { updateTagSettings } from '@/server/services/nfcService';
import { nfcTagSettingsSchema } from '@/lib/validation/nfc';

// Change how the Android app treats a scan of a tag ("open" the scan sheet, or
// a quick "notify" notification) and which list "Add to shopping list" uses.
export const POST = withAuth(async (ctx) => {
  await requireAnyAccess(ctx, 'inventory');
  const input = await parseBody(ctx.req, nfcTagSettingsSchema);
  return ok(await updateTagSettings(ctx.user.householdId!, input));
});
