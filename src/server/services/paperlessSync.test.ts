import { beforeEach, describe, expect, it, vi } from 'vitest';

// Disconnecting Paperless from Settings: the household's own saved connection
// and its import progress are deleted, and a server-wide Paperless
// (settings.yml/.env) stops being used for the household too, so Disconnect
// never leaves it connected.

type Conn = { householdId: string; url: string; publicUrl: string | null; tokenEnc: string };
let saved: Conn | null = null;
let syncRow: { householdId: string } | null = null;
let household: { id: string; paperlessServerOff: boolean | null; paperlessPrivateNetwork: boolean | null };

const prisma = {
  paperlessConnection: {
    findUnique: vi.fn(async () => saved),
    findMany: vi.fn(async () => (saved ? [{ householdId: saved.householdId }] : [])),
    deleteMany: vi.fn(async () => {
      saved = null;
    }),
  },
  paperlessSync: {
    findUnique: vi.fn(async () => (syncRow ? { ...syncRow, createdAt: new Date(), lastRunAt: null, lastError: null, lastResult: null } : null)),
    deleteMany: vi.fn(async () => {
      syncRow = null;
    }),
  },
  household: {
    findUnique: vi.fn(async () => household),
    update: vi.fn(async ({ data }: { data: Partial<typeof household> }) => Object.assign(household, data)),
    findFirst: vi.fn(async () => ({ id: 'h1' })),
  },
  user: {
    // The server admin lives in h1, so the server-wide Paperless is h1's.
    findFirst: vi.fn(async () => ({ id: 'u1', householdId: 'h1' })),
  },
  $transaction: vi.fn(async (ops: unknown) => (typeof ops === 'function' ? ops(prisma) : Promise.all(ops as unknown[]))),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/security/secrets', () => ({ decryptSecret: () => 'token', encryptSecret: () => 'enc' }));
vi.mock('@/server/services/serverAdminService', () => ({
  ensureServerAdmin: vi.fn(async () => undefined),
  isFeatureEnabled: vi.fn(async () => true),
  isHouseholdDisabled: vi.fn(async () => false),
}));

const { getPaperlessStatus, removePaperlessConnection, paperlessSources } = await import('./paperlessSync');

beforeEach(() => {
  vi.clearAllMocks();
  saved = null;
  syncRow = { householdId: 'h1' };
  household = { id: 'h1', paperlessServerOff: null, paperlessPrivateNetwork: null };
  delete process.env.PAPERLESS_HOUSEHOLD_ID;
});

function useServerPaperless(on: boolean) {
  if (on) {
    process.env.PAPERLESS_URL = 'http://paperless:8000';
    process.env.PAPERLESS_TOKEN = 'server-token';
  } else {
    delete process.env.PAPERLESS_URL;
    delete process.env.PAPERLESS_TOKEN;
  }
}

describe('removePaperlessConnection', () => {
  it('deletes the household’s own connection and its import progress', async () => {
    useServerPaperless(false);
    saved = { householdId: 'h1', url: 'http://own:8000', publicUrl: null, tokenEnc: 'enc' };
    const status = await removePaperlessConnection('h1');
    expect(prisma.paperlessConnection.deleteMany).toHaveBeenCalledWith({ where: { householdId: 'h1' } });
    expect(prisma.paperlessSync.deleteMany).toHaveBeenCalledWith({ where: { householdId: 'h1' } });
    expect(status.configured).toBe(false);
    // No server-wide Paperless to turn off.
    expect(household.paperlessServerOff).toBeNull();
  });

  it('turns off the server-wide Paperless for the household it was set up for', async () => {
    useServerPaperless(true);
    expect((await getPaperlessStatus('h1')).connection?.source).toBe('server');
    const status = await removePaperlessConnection('h1');
    expect(status.configured).toBe(false);
    expect(status.connection).toBeNull();
    expect(household.paperlessServerOff).toBe(true);
    expect(prisma.paperlessSync.deleteMany).toHaveBeenCalled();
    // The sweep and the Server page no longer list it either.
    expect((await paperlessSources()).has('h1')).toBe(false);
  });

  it('does not fall back to the server-wide Paperless after disconnecting the household’s own', async () => {
    useServerPaperless(true);
    saved = { householdId: 'h1', url: 'http://own:8000', publicUrl: null, tokenEnc: 'enc' };
    expect((await getPaperlessStatus('h1')).connection?.source).toBe('household');
    const status = await removePaperlessConnection('h1');
    expect(status.configured).toBe(false);
  });

  it('leaves the flag alone for a household the server-wide Paperless isn’t for', async () => {
    useServerPaperless(true);
    household = { id: 'h2', paperlessServerOff: null, paperlessPrivateNetwork: null };
    saved = { householdId: 'h2', url: 'https://own.example.com', publicUrl: null, tokenEnc: 'enc' };
    await removePaperlessConnection('h2');
    expect(prisma.household.update).not.toHaveBeenCalled();
  });

  it('a household that turned it off can still connect its own', async () => {
    useServerPaperless(true);
    household.paperlessServerOff = true;
    saved = { householdId: 'h1', url: 'http://own:8000', publicUrl: null, tokenEnc: 'enc' };
    expect((await getPaperlessStatus('h1')).connection?.source).toBe('household');
  });
});
