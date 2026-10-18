import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Member = { id: string; name: string; role: string };
type Linked = {
  id: string;
  name: string;
  username: string | null;
  displayUsername: string | null;
  householdId: string | null;
  setupLinkExpiresAt: Date | null;
  household: { name: string } | null;
};

const prisma = {
  user: {
    findFirst: vi.fn(async (): Promise<Member | Linked | null> => null),
    update: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const admin = { isHouseholdDisabled: vi.fn(async () => false) };
vi.mock('@/server/services/serverAdminService', () => admin);
const app = { getAppRelease: vi.fn((): { server: string } | null => null) };
vi.mock('@/server/services/appDownloadService', () => app);

const { appOpenLink, createSetupLink, hashSetupToken, qrRows, resolveSetupLink, setupBaseUrl } = await import(
  '@/server/services/setupLinkService'
);

const NOW = new Date('2026-10-17T20:00:00Z');
const noah: Member = { id: 'noah', name: 'Noah', role: 'teen' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'https://home.example.com');
});
afterEach(() => vi.unstubAllEnvs());

describe('setup links (Set up a child, phase 3)', () => {
  it('makes a link for a child or teen: only the hash is kept, it lasts 24 hours, and it is logged', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(noah);
    const link = await createSetupLink('h1', { id: 'alex' }, 'noah', 'http://192.0.2.10:3000/api/members/setup-link', NOW);

    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'noah', householdId: 'h1' } }));
    const token = link.url.split('/get-app/')[1];
    expect(link.url).toBe(`https://home.example.com/get-app/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'noah' },
      data: { setupLinkHash: hashSetupToken(token), setupLinkExpiresAt: new Date('2026-10-18T20:00:00Z') },
    });
    expect(JSON.stringify(prisma.user.update.mock.calls)).not.toContain(token);
    expect(link.expiresAt).toBe('2026-10-18T20:00:00.000Z');
    expect(link.qr.rows).toHaveLength(link.qr.size);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: 'h1', actorId: 'alex', subjectId: 'noah', message: 'made a setup link for “Noah”’s phone' }),
    );
  });

  it('refuses someone outside the household, and anyone who is not a child or teen', async () => {
    await expect(createSetupLink('h1', { id: 'alex' }, 'stranger', 'http://x', NOW)).rejects.toThrow('isn’t in your household');
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'jordan', name: 'Jordan', role: 'adult' });
    await expect(createSetupLink('h1', { id: 'alex' }, 'jordan', 'http://x', NOW)).rejects.toMatchObject({ field: 'memberId' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('points the link where their phone can reach the server', () => {
    // The address built into the app first, as on the Install step.
    app.getAppRelease.mockReturnValueOnce({ server: 'https://built.example.com/' });
    expect(setupBaseUrl('http://192.0.2.10:3000/x')).toBe('https://built.example.com');
    expect(setupBaseUrl('http://192.0.2.10:3000/x')).toBe('https://home.example.com');
    vi.stubEnv('BETTER_AUTH_URL', '');
    expect(setupBaseUrl('http://192.0.2.10:3000/x')).toBe('http://192.0.2.10:3000');
  });

  describe('resolving a link', () => {
    const row = (over: Partial<Linked> = {}): Linked => ({
      id: 'noah',
      name: 'Noah',
      username: 'noah',
      displayUsername: 'Noah_M',
      householdId: 'h1',
      setupLinkExpiresAt: new Date('2026-10-18T00:00:00Z'),
      household: { name: 'Maple House' },
      ...over,
    });
    const token = 'abcdefghijklmnopqrstuvwx';

    it('finds who it is for by the hash, with their username as they type it', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(row());
      expect(await resolveSetupLink(token, NOW)).toEqual({
        userId: 'noah',
        name: 'Noah',
        username: 'Noah_M',
        householdName: 'Maple House',
      });
      expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { setupLinkHash: hashSetupToken(token) } }));
    });

    it('ends: expired, unknown, malformed, or the household turned off', async () => {
      prisma.user.findFirst.mockResolvedValueOnce(row({ setupLinkExpiresAt: new Date('2026-10-17T19:59:59Z') }));
      expect(await resolveSetupLink(token, NOW)).toBeNull();
      expect(await resolveSetupLink(token, NOW)).toBeNull();
      expect(await resolveSetupLink('short', NOW)).toBeNull();
      expect(await resolveSetupLink('has spaces and/slashes!!', NOW)).toBeNull();
      prisma.user.findFirst.mockResolvedValueOnce(row());
      admin.isHouseholdDisabled.mockResolvedValueOnce(true);
      expect(await resolveSetupLink(token, NOW)).toBeNull();
    });
  });

  it('draws the QR code as rows of modules, with the finder pattern in the corner', () => {
    const qr = qrRows('https://home.example.com/get-app/abcdefghijklmnopqrstuvwx');
    expect(qr.rows).toHaveLength(qr.size);
    expect(qr.rows.every((r) => r.length === qr.size && /^[01]+$/.test(r))).toBe(true);
    expect(qr.rows[0].slice(0, 7)).toBe('1111111');
    expect(qr.rows[1].slice(0, 7)).toBe('1000001');
  });

  it('opens the app with the username and server, encoded', () => {
    expect(appOpenLink('noah', 'https://home.example.com')).toBe(
      'ourhome://setup?username=noah&server=https%3A%2F%2Fhome.example.com',
    );
  });
});
