import { z } from 'zod';

// Contract for the public contact form POSTed to /api/contact by anonymous
// visitors on the login page. name/email/description are the real inputs; the
// remaining fields are anti-spam signals the route inspects (see the route and
// AGENTS notes): `company` is a honeypot that must stay empty, `elapsedMs` is how
// long the form was open before submit (bots submit instantly), and
// `turnstileToken` is the Cloudflare Turnstile response verified server-side.
export const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  description: z.string().trim().min(10).max(5000),
  // Honeypot: rendered hidden, so a real user never fills it. Capped, not
  // rejected here — the route treats any non-empty value as a bot and silently
  // drops it (returning success so the bot learns nothing).
  company: z.string().max(100).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  // Optional so local dev (no Turnstile keys) works; verification is enforced by
  // verifyTurnstile only when TURNSTILE_SECRET_KEY is configured.
  turnstileToken: z.string().max(2048).optional().default(''),
});

export type ContactInput = z.infer<typeof contactSchema>;
