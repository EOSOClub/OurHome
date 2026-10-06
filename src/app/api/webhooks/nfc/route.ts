import { type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { fail, ok, parseBody } from '@/server/api/http';
import {
  extractIntegrationToken,
  resolveHouseholdByToken,
} from '@/server/services/integrationService';
import { ingestNfcScan } from '@/server/services/eventService';
import { nfcScanWebhookSchema } from '@/lib/validation/events';
import { NotFoundError } from '@/server/services/errors';

// Home Assistant calls this endpoint over the LAN when an NFC tag is scanned.
// It authenticates with a shared bearer token (see HomeAssistantIntegration)
// rather than a session cookie, so it does NOT use withAuth.
export async function POST(req: NextRequest): Promise<Response> {
  const token = extractIntegrationToken(req);
  if (!token) return fail('Missing token', 401);

  const resolved = await resolveHouseholdByToken(token);
  if (!resolved) return fail('Invalid token', 401);

  try {
    const input = await parseBody(req, nfcScanWebhookSchema);
    const item = await ingestNfcScan(resolved.householdId, input);
    return ok(item);
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('Validation failed', 422, z.flattenError(err));
    }
    if (err instanceof NotFoundError) {
      return fail(err.message, 404);
    }
    console.error('[webhook] nfc scan failed', err);
    return fail('Internal server error', 500);
  }
}
