import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAssertion,
  isDeadTokenResponse,
  parseServiceAccount,
  type ServiceAccount,
} from '@/server/push/fcm';

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
