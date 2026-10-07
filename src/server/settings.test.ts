import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { flattenSettings, resolveSecrets } from './settings';

const doc = parse(`
app:
  name: Our Home
better_auth:
  secret: "abc#123"
  url: https://home.example.com
  trusted_origins: [https://a.example, https://b.example]
smtp:
  host: mail.example.com
  port: 587
  user:
csp:
  report_only: false
paperless:
  field:
    due_date: Due date
docker:
  port: 3000
dev:
  better_auth:
    url: http://localhost:3000
  smtp:
    host: ""
`);

describe('flattenSettings', () => {
  it('names variables after the key path', () => {
    const env = flattenSettings(doc, 'server');
    expect(env.APP_NAME).toBe('Our Home');
    expect(env.BETTER_AUTH_SECRET).toBe('abc#123');
    expect(env.PAPERLESS_FIELD_DUE_DATE).toBe('Due date');
    expect(env.DOCKER_PORT).toBe('3000');
  });

  it('joins lists and blanks empty values', () => {
    const env = flattenSettings(doc, 'server');
    expect(env.BETTER_AUTH_TRUSTED_ORIGINS).toBe('https://a.example,https://b.example');
    expect(env.SMTP_USER).toBe('');
    expect(env.SMTP_PORT).toBe('587');
    expect(env.CSP_REPORT_ONLY).toBe('false');
  });

  it('uses the server values in server mode and drops dev', () => {
    const env = flattenSettings(doc, 'server');
    expect(env.BETTER_AUTH_URL).toBe('https://home.example.com');
    expect(env.SMTP_HOST).toBe('mail.example.com');
    expect(Object.keys(env).some((k) => k.startsWith('DEV_'))).toBe(false);
  });

  it('merges dev over the rest in dev mode', () => {
    const env = flattenSettings(doc, 'dev');
    expect(env.BETTER_AUTH_URL).toBe('http://localhost:3000');
    expect(env.SMTP_HOST).toBe('');
    // Untouched siblings survive the merge.
    expect(env.BETTER_AUTH_SECRET).toBe('abc#123');
    expect(env.SMTP_PORT).toBe('587');
  });

  it('treats an empty or non-map document as no settings', () => {
    expect(flattenSettings(null, 'server')).toEqual({});
    expect(flattenSettings('text', 'dev')).toEqual({});
  });
});

describe('resolveSecrets', () => {
  const vars = {
    DATABASE_URL: 'mongodb://server',
    DEV_DATABASE_URL: 'mongodb://localhost',
    FIREBASE_SERVICE_ACCOUNT: 'key',
    DEV_FIREBASE_SERVICE_ACCOUNT: '',
    CRON_SECRET: 'c',
  };

  it('uses the plain names on the server and ignores DEV_ entries', () => {
    const env = resolveSecrets(vars, 'server');
    expect(env.DATABASE_URL).toBe('mongodb://server');
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe('key');
    expect(Object.keys(env).some((k) => k.startsWith('DEV_'))).toBe(false);
  });

  it('lets DEV_ entries replace their name in dev, empty ones turning it off', () => {
    const env = resolveSecrets(vars, 'dev');
    expect(env.DATABASE_URL).toBe('mongodb://localhost');
    expect(env.FIREBASE_SERVICE_ACCOUNT).toBe('');
    expect(env.CRON_SECRET).toBe('c');
  });
});
