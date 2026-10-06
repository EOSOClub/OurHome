// Server-side verification for Cloudflare Turnstile. The widget on the client
// produces a one-time token; we exchange it here for a pass/fail with Cloudflare.
// This is a server->server call, so it is NOT subject to the browser CSP.
//
// Mirrors the mailer's graceful fallback: if TURNSTILE_SECRET_KEY is unset in
// local dev, verification is skipped and returns true, so the contact flow stays
// testable without provisioning keys. In production a missing secret fails
// CLOSED — silently skipping verification there would disable bot protection.

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string,
  ip?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[turnstile] TURNSTILE_SECRET_KEY is not set in production; rejecting verification (fail closed). Set the secret to re-enable the contact flow.',
      );
      return false;
    }
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set; skipping verification');
    return true;
  }
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean }
      | null;
    return data?.success === true;
  } catch (err) {
    console.error('[turnstile] verification request failed', err);
    return false;
  }
}
