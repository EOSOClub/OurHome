import { ok, parseBody, parseQuery, requireAnyAccess, withAuth } from '@/server/api/http';
import { ingestNfcScan, listRecentScans } from '@/server/services/eventService';
import { nfcAppScanSchema, nfcScansQuerySchema } from '@/lib/validation/nfc';

// Recent tag scans/setups from Home Assistant and the Android app.
export const GET = withAuth(async (ctx) => {
  const { limit } = parseQuery(ctx.req, nfcScansQuerySchema);
  return ok(await listRecentScans(ctx.user.householdId!, limit));
});

// Apply a scan from the Android app: same handling as the HA webhook, but as
// the signed-in user (source "nfc"). An unknown tag 404s — the app sets it up
// first via /api/nfc/setup.
export const POST = withAuth(async (ctx) => {
  await requireAnyAccess(ctx, 'inventory');
  const input = await parseBody(ctx.req, nfcAppScanSchema);
  const item = await ingestNfcScan(ctx.user.householdId!, input, {
    actorId: ctx.user.id,
    source: 'nfc',
  });
  return ok(item);
});
