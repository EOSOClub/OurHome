import { type NextRequest } from 'next/server';
import { ZodError } from 'zod';
import { PUBLIC_BODY_MAX_BYTES, fail, ok, parseBody, validationFailed } from '@/server/api/http';
import {
  extractIntegrationToken,
  resolveHouseholdByToken,
} from '@/server/services/integrationService';
import { ingestNfcScan } from '@/server/services/eventService';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { nfcScanWebhookSchema } from '@/lib/validation/events';
import { ConflictError, NotFoundError, PayloadTooLargeError } from '@/server/services/errors';

// Home Assistant calls this endpoint over the LAN when an NFC tag is scanned.
// It authenticates with a shared bearer token (see HomeAssistantIntegration)
// rather than a session cookie, so it does NOT use withAuth.
export async function POST(req: NextRequest): Promise<Response> {
  const token = extractIntegrationToken(req);
  if (!token) return fail('Missing token', 401);

  const resolved = await resolveHouseholdByToken(token);
  if (!resolved) return fail('Invalid token', 401);
  // Scans change stock: refused while Inventory is off, as in the app.
  if (!(await isFeatureEnabled(resolved.householdId, 'inventory'))) {
    return fail('Inventory is turned off for this household.', 403);
  }

  try {
    const input = await parseBody(req, nfcScanWebhookSchema, PUBLIC_BODY_MAX_BYTES);
    const item = await ingestNfcScan(resolved.householdId, input);
    return ok(item);
  } catch (err) {
    if (err instanceof ZodError) {
      return validationFailed(err);
    }
    if (err instanceof PayloadTooLargeError) return fail('Request too large', 413);
    if (err instanceof NotFoundError) {
      return fail(err.message, 404);
    }
    // A new tag's first scan sent twice, or a stock change that kept losing
    // to another: "scan again", not a server error.
    if (err instanceof ConflictError) return fail(err.message, 409);
    console.error('[webhook] nfc scan failed', err);
    return fail('Internal server error', 500);
  }
}
