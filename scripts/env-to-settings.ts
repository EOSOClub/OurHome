import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { parseDocument } from 'yaml';

// One-time move from the old all-in-one .env to settings.yml + a secrets-only
// .env:
//
//   npm run settings:migrate            # reads .env, writes settings.yml + .env
//   npm run settings:migrate -- --force # overwrite an existing settings.yml
//
// Starts from settings.example.yml and .env.example (so their comments stay).
// The old file is kept as .env.old; delete it once the app runs. Prints
// variable names only, never values.

// Old .env name -> settings.yml path (not secret).
const SETTINGS: Record<string, string[]> = {
  APP_NAME: ['app', 'name'],
  BETTER_AUTH_TRUSTED_ORIGINS: ['better_auth', 'trusted_origins'],
  PUBLIC_URL: ['better_auth', 'url'],
  BETTER_AUTH_URL: ['dev', 'better_auth', 'url'],
  SERVER_SMTP_HOST: ['smtp', 'host'],
  SMTP_PORT: ['smtp', 'port'],
  SMTP_USER: ['smtp', 'user'],
  SMTP_FROM: ['smtp', 'from'],
  CONTACT_FORWARD_TO: ['contact', 'forward_to'],
  BUG_REPORT_EMAIL: ['bug_report', 'email'],
  SERVER_TURNSTILE_SITE_KEY: ['turnstile', 'site_key'],
  SERVER_PAPERLESS_URL: ['paperless', 'url'],
  PAPERLESS_PUBLIC_URL: ['paperless', 'public_url'],
  PAPERLESS_BILL_TAG: ['paperless', 'bill_tag'],
  PAPERLESS_PAYMENT_TAG: ['paperless', 'payment_tag'],
  PAPERLESS_PENDING_TAGS: ['paperless', 'pending_tags'],
  PAPERLESS_FIELD_AMOUNT: ['paperless', 'field', 'amount'],
  PAPERLESS_FIELD_DUE_DATE: ['paperless', 'field', 'due_date'],
  PAPERLESS_FIELD_ACCOUNT: ['paperless', 'field', 'account'],
  PAPERLESS_FIELD_INVOICE: ['paperless', 'field', 'invoice'],
  PAPERLESS_HOUSEHOLD_ID: ['paperless', 'household_id'],
  CSP_REPORT_ONLY: ['csp', 'report_only'],
  DOCKER_NETWORK: ['docker', 'network'],
  WEB_HOST_PORT: ['docker', 'port'],
  WEB_BIND: ['docker', 'bind'],
};
// Old .env name -> new .env name (secret). The old file kept server values
// under SERVER_*; the new one uses the real names, with DEV_ for local dev.
const SECRETS: Record<string, string> = {
  BETTER_AUTH_SECRET: 'BETTER_AUTH_SECRET',
  CRON_SECRET: 'CRON_SECRET',
  SERVER_DATABASE_URL: 'DATABASE_URL',
  DATABASE_URL: 'DEV_DATABASE_URL',
  SMTP_PASS: 'SMTP_PASS',
  SERVER_TURNSTILE_SECRET_KEY: 'TURNSTILE_SECRET_KEY',
  SERVER_FIREBASE_SERVICE_ACCOUNT: 'FIREBASE_SERVICE_ACCOUNT',
  SERVER_PAPERLESS_TOKEN: 'PAPERLESS_TOKEN',
};
const LISTS = new Set(['BETTER_AUTH_TRUSTED_ORIGINS', 'PAPERLESS_PENDING_TAGS']);
const NUMBERS = new Set(['SMTP_PORT', 'WEB_HOST_PORT']);
// Gone for good (first-run setup replaced the seed).
const DROPPED = /^SEED_/;

const force = process.argv.includes('--force');
console.log('[migrate] old .env -> settings.yml + secrets-only .env');
if (!existsSync('.env')) {
  console.error('[migrate] no .env here; nothing to migrate');
  process.exit(1);
}
const old = parseEnv(readFileSync('.env', 'utf8'));
if (!Object.keys(old).some((name) => name in SETTINGS || name.startsWith('SERVER_'))) {
  console.error('[migrate] .env already looks secrets-only; nothing to migrate');
  process.exit(1);
}
if (existsSync('settings.yml') && !force) {
  console.error('[migrate] settings.yml already exists; pass --force to overwrite it');
  process.exit(1);
}

const doc = parseDocument(readFileSync('settings.example.yml', 'utf8'));
const secrets: Record<string, string> = {};
const moved: string[] = [];
const skipped: string[] = [];
const unknown: string[] = [];

for (const [name, raw] of Object.entries(old)) {
  const value = (raw ?? '').trim();
  if (SECRETS[name]) {
    secrets[SECRETS[name]] = value;
    moved.push(`${name}→.env ${SECRETS[name]}`);
  } else if (SETTINGS[name]) {
    const path = SETTINGS[name];
    if (LISTS.has(name)) {
      doc.setIn(path, value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
    } else if (NUMBERS.has(name) && /^\d+$/.test(value)) {
      doc.setIn(path, Number(value));
    } else if (name === 'CSP_REPORT_ONLY') {
      doc.setIn(path, value === 'true');
    } else {
      doc.setIn(path, value);
    }
    moved.push(`${name}→${path.join('.')}`);
  } else {
    (DROPPED.test(name) ? skipped : unknown).push(name);
  }
}

// Single quotes keep a value literal for both Node and compose, which would
// otherwise expand `$` and treat ` #` as a comment.
const envValue = (v: string) => (/[\s#$"'`\\]/.test(v) ? `'${v}'` : v);

// The new .env: the template, with each NAME= line filled in where known.
const envOut = readFileSync('.env.example', 'utf8')
  .split(/\r?\n/)
  .map((line) => {
    const m = /^([A-Z_]+)=/.exec(line);
    return m && m[1] in secrets ? `${m[1]}=${envValue(secrets[m[1]])}` : line;
  })
  .join('\n');

copyFileSync('.env', '.env.old');
writeFileSync('settings.yml', doc.toString({ lineWidth: 0 }));
writeFileSync('.env', envOut);

console.log(`[migrate] moved ${moved.length}: ${moved.join(', ') || 'none'}`);
if (skipped.length) console.log(`[migrate] dropped (no longer used): ${skipped.join(', ')}`);
if (unknown.length) {
  console.log(`[migrate] NOT moved, add by hand if still needed: ${unknown.join(', ')}`);
}
console.log('[migrate] wrote settings.yml and .env; the old file is .env.old.');
console.log('[migrate] Check both, then delete .env.old (it still holds every secret).');
