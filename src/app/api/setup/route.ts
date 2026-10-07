import type { NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { clientIp, fail, ok, rateLimit } from '@/server/api/http';
import { isFromLocalNetwork } from '@/server/security/network';
import { ConflictError } from '@/server/services/errors';
import {
  completeSetup,
  needsSetup,
  setupRequiredMessage,
} from '@/server/services/setupService';
import { setupSchema } from '@/lib/validation/setup';

/**
 * Whether this server still needs first-run setup, so a client (the Android
 * app, a script) can tell "not set up yet" apart from "can't connect".
 */
export async function GET(req: NextRequest): Promise<Response> {
  const setupRequired = await needsSetup();
  return ok({
    setupRequired,
    message: setupRequired ? setupRequiredMessage(req.headers, req.url) : null,
  });
}

/**
 * First-run setup: creates the household and its Head of House. Public (there
 * is no one to sign in as yet), so it only answers while no account exists and
 * only to devices on the home network, never through a tunnel or proxy from the
 * internet, so a fresh install that is already exposed can't be claimed.
 */
export async function POST(req: NextRequest): Promise<Response> {
  if (!rateLimit(`setup:${clientIp(req)}`, 60_000, 10)) {
    return fail('Too many requests', 429);
  }
  if (!isFromLocalNetwork(req.headers)) {
    return fail('Finish setup from a device on your home network.', 403);
  }

  try {
    const input = setupSchema.parse(await req.json().catch(() => ({})));
    return ok(await completeSetup(input), { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('Validation failed', 422, z.flattenError(err));
    }
    if (err instanceof ConflictError) return fail(err.message, 409);
    console.error('[setup] failed', err);
    return fail('Internal server error', 500);
  }
}
