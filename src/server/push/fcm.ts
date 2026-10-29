import { createSign } from 'node:crypto';

// Minimal Firebase Cloud Messaging (HTTP v1) sender. It talks to the REST API
// directly instead of using firebase-admin, which needs a newer Node than the
// Docker image runs and pulls in far more than one POST needs.
//
// Auth: the service account signs a short JWT, which Google trades for an
// OAuth access token (cached until shortly before it expires).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Reads the service-account key from FIREBASE_SERVICE_ACCOUNT: the JSON file's
 * contents, either as-is or base64-encoded (easier to keep on one settings.yml line).
 * Unset or empty → null (push off). Malformed → logged, then null.
 */
export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const text = value.startsWith('{') ? value : Buffer.from(value, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as Partial<ServiceAccount>;
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      console.error('[push] FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key; push is off.');
      return null;
    }
    return {
      project_id: parsed.project_id,
      client_email: parsed.client_email,
      private_key: parsed.private_key,
    };
  } catch {
    console.error('[push] FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of it); push is off.');
    return null;
  }
}

const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);

export function isPushConfigured(): boolean {
  return account !== null;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** The signed JWT exchanged for an access token (RFC 7523 bearer grant). */
export function buildAssertion(sa: ServiceAccount, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(sa: ServiceAccount): Promise<string> {
  // Refresh a minute early so a token never expires mid-send.
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildAssertion(sa, Math.floor(Date.now() / 1000)),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

/** `invalid_token`: the install is gone (uninstalled, data cleared); drop it. */
export type SendResult = 'sent' | 'invalid_token' | 'failed';

/**
 * FCM's answer for a token that will never work again: 404 UNREGISTERED, or a
 * 400 that names the registration token (malformed). Other 400s are our bug,
 * not the device's, so the token is kept.
 */
export function isDeadTokenResponse(status: number, body: string): boolean {
  if (status === 404 || body.includes('UNREGISTERED')) return true;
  return status === 400 && /registration token/i.test(body);
}

/**
 * How urgently Firebase delivers. `high` reaches a dozing phone at once, but
 * Firebase quietly demotes an installation's high-priority messages when they
 * keep ending without a visible notification, and that would slow a ring or a
 * live check too. So anything the phone handles silently is `normal`: it still
 * arrives at once on a phone in use, and at Doze's next window otherwise.
 */
export type PushPriority = 'high' | 'normal';

/**
 * Sends a data-only message (no `notification` block, so Android never shows
 * anything by itself: the app decides what to post). [ttlSec]: how long
 * Firebase keeps trying a phone that's offline (a ring is pointless an hour
 * late). Never throws.
 */
export async function sendData(
  token: string,
  data: Record<string, string>,
  ttlSec: number = 3600,
  priority: PushPriority = 'high',
): Promise<SendResult> {
  if (!account) return 'failed';
  for (let attempt = 0; ; attempt++) {
    let wait: number | null;
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${await accessToken(account)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: { token, data, android: { priority, ttl: `${ttlSec}s` } },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (res.ok) return 'sent';
      const body = await res.text();
      if (res.status === 401) cached = null; // revoked or expired early; re-mint next time
      if (isDeadTokenResponse(res.status, body)) return 'invalid_token';
      wait = retryDelayMs(res.status, res.headers.get('retry-after'), attempt);
      console.warn(
        `[push] FCM send failed (${res.status})${wait === null ? '' : `, retrying in ${wait} ms`}: ${body.slice(0, 300)}`,
      );
    } catch (err) {
      // A timeout may still have been delivered, and a ring waits on this:
      // only a connection that never got through is tried again.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      wait = timedOut ? null : retryDelayMs(null, null, attempt);
      console.warn(`[push] FCM send failed${wait === null ? '' : `, retrying in ${wait} ms`}:`, err);
    }
    if (wait === null) return 'failed';
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Tries per message, the first included. */
export const SEND_ATTEMPTS = 3;
/** The longest a `Retry-After` is honoured; past it the push waits for the hourly check. */
const MAX_RETRY_WAIT_MS = 10_000;

/**
 * How long to wait before trying a failed send again, or null to give up.
 * [status] null: the request never got an answer (connection refused, DNS).
 * Retried: that, 429 (FCM's quota) and 5xx (FCM down for a moment), as
 * Firebase asks: its `Retry-After` when given, else 0.5 s then 1 s.
 */
export function retryDelayMs(status: number | null, retryAfter: string | null, attempt: number): number | null {
  if (attempt >= SEND_ATTEMPTS - 1) return null;
  const retryable = status === null || status === 429 || (status >= 500 && status <= 599);
  if (!retryable) return null;
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = seconds * 1000;
    return ms > MAX_RETRY_WAIT_MS ? null : ms;
  }
  return 500 * 2 ** attempt;
}
