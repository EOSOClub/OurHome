import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOUSEHOLD_MODELS, SERVER_MODELS } from '@/server/services/householdDataService';

const schema = readFileSync(join(process.cwd(), 'prisma', 'schema', 'models.prisma'), 'utf8');
const service = readFileSync(join(process.cwd(), 'src', 'server', 'services', 'householdDataService.ts'), 'utf8');
const models = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);

describe('household export / delete coverage', () => {
  it('decides for every model whether a household owns it', () => {
    const decided = new Set<string>([...HOUSEHOLD_MODELS, ...SERVER_MODELS]);
    expect(models.filter((m) => !decided.has(m))).toEqual([]);
    expect([...decided].filter((m) => !models.includes(m))).toEqual([]);
  });

  it('deletes every household model', () => {
    const deleted = new Set([...service.matchAll(/count\('(\w+)'/g)].map((m) => m[1]));
    expect(HOUSEHOLD_MODELS.filter((m) => !deleted.has(m))).toEqual([]);
  });

  it('never exports credentials', () => {
    const exportFn = service.slice(service.indexOf('export async function exportHousehold'), service.indexOf('// --- Delete'));
    for (const secret of ['password', 'tokenHash', 'tokenEnc', 'prisma.session', 'prisma.account', 'prisma.pushDevice']) {
      expect(exportFn).not.toContain(secret);
    }
  });
});
