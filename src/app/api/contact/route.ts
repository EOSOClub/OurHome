import { type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { clientIp, fail, ok, rateLimit } from '@/server/api/http';
import { submitContactMessage } from '@/server/services/contactService';
import { verifyTurnstile } from '@/server/security/turnstile';
import { contactSchema } from '@/lib/validation/contact';

// Public, unauthenticated contact form. Like the webhook routes it does NOT use
// withAuth (there's no session). Layered anti-spam: strict per-IP rate limit,
// honeypot, submit-timing check, and Cloudflare Turnstile.

// Budget: 5 submissions per hour per IP.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
// Reject submissions faster than this — humans don't fill a form in under 3s.
const MIN_ELAPSED_MS = 3000;

export async function POST(req: NextRequest): Promise<Response> {
  const ip = clientIp(req);
  if (!rateLimit(`contact:${ip}`, RATE_WINDOW_MS, RATE_MAX)) {
    return fail('Too many requests. Please try again later.', 429);
  }

  let input;
  try {
    const raw = await req.json().catch(() => ({}));
    input = contactSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      return fail('Validation failed', 422, z.flattenError(err));
    }
    return fail('Invalid request', 400);
  }

  // Honeypot filled or submitted implausibly fast -> almost certainly a bot.
  // Return success without doing anything so the bot gets no signal to adapt.
  if (input.company && input.company.trim() !== '') {
    return ok({ delivered: true });
  }
  if (typeof input.elapsedMs === 'number' && input.elapsedMs < MIN_ELAPSED_MS) {
    return ok({ delivered: true });
  }

  const humanVerified = await verifyTurnstile(input.turnstileToken, ip);
  if (!humanVerified) {
    return fail('Verification failed. Please try again.', 400);
  }

  await submitContactMessage(
    { name: input.name, email: input.email, description: input.description },
    { ip, userAgent: req.headers.get('user-agent') ?? undefined },
  );

  return ok({ delivered: true });
}
