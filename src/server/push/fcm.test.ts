import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAssertion,
  isDeadTokenResponse,
  parseServiceAccount,
  retryDelayMs,
  SEND_ATTEMPTS,
  type ServiceAccount,
} from '@/server/push/fcm';

describe('retryDelayMs', () => {
  it('backs off on FCM busy or down, and on a connection that never got through', () => {
    expect(retryDelayMs(503, null, 0)).toBe(500);
    expect(retryDelayMs(500, null, 1)).toBe(1000);
    expect(retryDelayMs(429, null, 0)).toBe(500);
    expect(retryDelayMs(null, null, 0)).toBe(500);
  });

  it('honours Retry-After, but not one so long the push is better left to the hourly check', () => {
    expect(retryDelayMs(429, '3', 0)).toBe(3000);
    expect(retryDelayMs(503, '0', 0)).toBe(0);
    expect(retryDelayMs(429, '60', 0)).toBeNull();
    // An HTTP date isn't parsed: the usual backoff instead.
    expect(retryDelayMs(503, 'Wed, 21 Oct 2026 07:28:00 GMT', 0)).toBe(500);
  });

  it('gives up after the last attempt, and never retries our own mistakes', () => {
    expect(retryDelayMs(503, null, SEND_ATTEMPTS - 1)).toBeNull();
    expect(retryDelayMs(400, null, 0)).toBeNull();
    expect(retryDelayMs(403, null, 0)).toBeNull();
    expect(retryDelayMs(404, null, 0)).toBeNull();
  });
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: ServiceAccount = {
  project_id: 'our-home-test',
  client_email: 'push@our-home-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

describe('parseServiceAccount', () => {
  it('is off when unset or blank', () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount('   ')).toBeNull();
  });

  it('accepts the raw JSON and base64 of it', () => {
    const json = JSON.stringify({ ...account, type: 'service_account' });
    expect(parseServiceAccount(json)).toEqual(account);
    expect(parseServiceAccount(Buffer.from(json).toString('base64'))).toEqual(account);
  });

  it('rejects garbage and keys missing a field', () => {
    expect(parseServiceAccount('not json at all')).toBeNull();
    expect(parseServiceAccount(JSON.stringify({ project_id: 'x' }))).toBeNull();
  });
});

describe('buildAssertion', () => {
  it('is an RS256 JWT for the FCM scope, signed by the service account', () => {
    const jwt = buildAssertion(account, 1_000);
    const [header, claims, signature] = jwt.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000,
      exp: 4_600,
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(valid).toBe(true);
  });
});

describe('isDeadTokenResponse', () => {
  it('drops uninstalled and malformed tokens', () => {
    expect(isDeadTokenResponse(404, '{"error":{"status":"NOT_FOUND"}}')).toBe(true);
    expect(isDeadTokenResponse(400, '{"details":[{"errorCode":"UNREGISTERED"}]}')).toBe(true);
    expect(isDeadTokenResponse(400, 'The registration token is not a valid FCM registration token')).toBe(true);
  });

  it('keeps the token for errors that are not about it', () => {
    expect(isDeadTokenResponse(400, 'Invalid JSON payload received')).toBe(false);
    expect(isDeadTokenResponse(401, 'Request had invalid authentication credentials')).toBe(false);
    expect(isDeadTokenResponse(503, 'unavailable')).toBe(false);
  });
});
