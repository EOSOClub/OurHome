import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updateTagSettings } from '@/server/services/nfcService';
import { nfcTagSettingsSchema } from '@/lib/validation/nfc';

// Change how the Android app treats a scan of a tag ("open" the scan sheet, or
// a quick "notify" notification) and which list "Add to shopping list" uses.
// Needs edit access to Inventory (owner, 2026-11-08): view-only members can
// scan a tag but not change what it does. A tag records no creator, so it
// counts as someone else's record ("Edit others'").
export const POST = withAuth(async (ctx) => {
  await requireModify(ctx, 'inventory', 'edit', null);
  const input = await parseBody(ctx.req, nfcTagSettingsSchema);
  return ok(await updateTagSettings(ctx.user.householdId!, input));
});
