import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

// Configuration comes from two gitignored files in the repo root, read here at
// startup into process.env so the rest of the code keeps reading plain
// environment variables:
//
//   settings.yml  everything a household changes that isn't secret
//                 (template: settings.example.yml)
//   .env          secrets only: passwords, keys, tokens (template: .env.example)
//
// settings.yml keys flatten to variable names: nested keys join with "_" and
// are uppercased, so `smtp.host` is SMTP_HOST and `paperless.field.due_date` is
// PAPERLESS_FIELD_DUE_DATE. Lists join with commas; empty values become "".
//
// Both files have a dev override, applied when not running in production
// (npm run dev, the Prisma CLI), so one pair serves local development and the
// server: settings.yml's `dev:` section is merged over the rest, and in .env a
// DEV_NAME entry replaces NAME. settings.yml's `docker:` section is read by the
// deploy scripts for Compose (port, names, network); the app ignores it.
//
// In Docker, compose passes .env to the container as environment variables
// (env_file) and mounts settings.yml read-only.

export type SettingsMode = 'dev' | 'server';

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isTree(value) && isTree(out[key]) ? merge(out[key] as Tree, value) : value;
  }
  return out;
}

/** The settings.yml document as environment variables, for `mode`. */
export function flattenSettings(doc: unknown, mode: SettingsMode): Record<string, string> {
  if (!isTree(doc)) return {};
  const { dev, ...rest } = doc;
  const tree = mode === 'dev' && isTree(dev) ? merge(rest, dev) : rest;

  const env: Record<string, string> = {};
  const walk = (node: unknown, parts: string[]) => {
    if (isTree(node)) {
      for (const [key, value] of Object.entries(node)) walk(value, [...parts, key]);
      return;
    }
    const name = parts.join('_').toUpperCase();
    if (Array.isArray(node)) env[name] = node.map((v) => String(v ?? '')).join(',');
    else env[name] = node == null ? '' : String(node);
  };
  walk(tree, []);
  return env;
}

const DEV_PREFIX = 'DEV_';

/**
 * The secrets for `mode`, from .env entries: NAME as-is, and in dev mode any
 * DEV_NAME replacing NAME (an empty DEV_NAME turns a server-only secret off).
 */
export function resolveSecrets(
  vars: Record<string, string | undefined>,
  mode: SettingsMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (!name.startsWith(DEV_PREFIX) && value !== undefined) out[name] = value;
  }
  if (mode === 'dev') {
    for (const [name, value] of Object.entries(vars)) {
      if (name.startsWith(DEV_PREFIX) && value !== undefined) {
        out[name.slice(DEV_PREFIX.length)] = value;
      }
    }
  }
  return out;
}

/** settings.yml in the working directory, or SETTINGS_FILE when set. */
export function settingsFile(): string {
  return process.env.SETTINGS_FILE || path.join(process.cwd(), 'settings.yml');
}

/** .env in the working directory, or SECRETS_FILE when set. */
export function secretsFile(): string {
  return process.env.SECRETS_FILE || path.join(process.cwd(), '.env');
}

export function defaultMode(): SettingsMode {
  return process.env.NODE_ENV === 'production' ? 'server' : 'dev';
}

/** settings.yml as environment variables for `mode` ({} when there's no file). */
export function readSettings(mode: SettingsMode = defaultMode()): Record<string, string> {
  const file = settingsFile();
  return existsSync(file) ? flattenSettings(parse(readFileSync(file, 'utf8')), mode) : {};
}

/**
 * Read settings.yml, then the secrets, into process.env. Secrets come from the
 * .env file when there is one (local dev), otherwise from the environment
 * itself (Docker passes .env in as variables). Secrets win if a name is in
 * both. Safe to call more than once.
 */
export function loadSettings(mode: SettingsMode = defaultMode()): {
  file: string;
  found: boolean;
  applied: number;
  /** Where the secrets came from: the .env file, or the environment (Docker). */
  secretsFrom: string;
} {
  const file = settingsFile();
  const found = existsSync(file);
  const settings = readSettings(mode);
  for (const [name, value] of Object.entries(settings)) process.env[name] = value;

  const envFile = secretsFile();
  const hasEnvFile = existsSync(envFile);
  const fromFile = hasEnvFile ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const secrets = resolveSecrets({ ...process.env, ...fromFile }, mode);
  for (const [name, value] of Object.entries(secrets)) process.env[name] = value;

  return {
    file,
    found,
    applied: Object.keys(settings).length,
    secretsFrom: hasEnvFile ? envFile : 'the environment',
  };
}

/** One startup log line describing what loadSettings() read. */
export function describeLoad(result: ReturnType<typeof loadSettings>): string {
  const settings = result.found
    ? `${result.applied} settings from ${result.file}`
    : `no ${result.file}`;
  return `[settings] ${settings}; secrets from ${result.secretsFrom}`;
}
