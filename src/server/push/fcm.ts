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
 * contents, either as-is or base64-encoded (easier to keep on one .env line).
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
 * Sends a data-only message (no `notification` block, so Android never shows
 * anything by itself: the app decides what to post). High priority so it
 * reaches a dozing phone promptly. Never throws.
 */
export async function sendData(token: string, data: Record<string, string>): Promise<SendResult> {
  if (!account) return 'failed';
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
          message: { token, data, android: { priority: 'high', ttl: '3600s' } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (res.ok) return 'sent';
    const body = await res.text();
    if (res.status === 401) cached = null; // revoked or expired early; re-mint next time
    if (isDeadTokenResponse(res.status, body)) return 'invalid_token';
    console.warn(`[push] FCM send failed (${res.status}): ${body.slice(0, 300)}`);
    return 'failed';
  } catch (err) {
    console.warn('[push] FCM send failed:', err);
    return 'failed';
  }
}
