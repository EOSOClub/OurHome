import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Several households share one server, so every API route must find out who is
// calling (withAuth: session → their household) unless it's one of the few
// deliberately public or token-authenticated endpoints below. A new route that
// forgets withAuth fails here instead of quietly serving every household.
const PUBLIC_ROUTES = new Set([
  'auth/[...all]/route.ts', // Better Auth itself (sign-in, sign-out, password)
  'cron/reminders/route.ts', // CRON_SECRET bearer token
  'integrations/inventory/route.ts', // Home Assistant integration token → its household
  'setup/route.ts', // first-run setup, only while the server has no accounts
]);

const API_DIR = join(process.cwd(), 'src', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

describe('API routes', () => {
  const files = routeFiles(API_DIR).map((f) => ({
    path: relative(API_DIR, f).split(sep).join('/'),
    source: readFileSync(f, 'utf8'),
  }));

  it('finds the routes', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('authenticate with withAuth unless listed as public', () => {
    const unguarded = files
      .filter((f) => !PUBLIC_ROUTES.has(f.path))
      .filter((f) => /export const (GET|POST|PUT|PATCH|DELETE)\s*=/.test(f.source) && !f.source.includes('withAuth('))
      .map((f) => f.path);
    expect(unguarded).toEqual([]);
  });

  it('never take the household from the request (it comes from the session)', () => {
    const offenders = files
      .filter((f) => /(input|body|params|query)\.householdId/.test(f.source))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
