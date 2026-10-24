import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  blockedApp: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    count: vi.fn(async () => 0),
  },
  user: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  appIcon: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { blockedAppNames, blockedAppsByKid, isBlockedFor, phoneBlocks } = await import('./appBlockService');

const H = 'h1';
const at = new Date('2026-10-24T15:00:00Z');
const row = (userId: string, app: string, label: string, blockedById: string, createdAt = at) => ({
  userId,
  app,
  label,
  blockedById,
  createdAt,
});

describe('blocked apps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives a phone its blocks with who blocked each, by name', async () => {
    prisma.blockedApp.findMany.mockResolvedValueOnce([
      row('riley', 'com.roblox.client', 'Roblox', 'alex'),
      row('riley', 'com.zhiliaoapp.musically', 'TikTok', 'gone'),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'alex', name: 'Alex' }]);
    expect(await phoneBlocks(H, 'riley')).toEqual([
      { app: 'com.roblox.client', label: 'Roblox', by: 'Alex' },
      // Blocked by someone since removed: the phone says "an adult".
      { app: 'com.zhiliaoapp.musically', label: 'TikTok', by: null },
    ]);
    expect(prisma.blockedApp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, userId: 'riley' } }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['alex', 'gone'] } },
      select: { id: true, name: true },
    });
  });

  it('lists each child’s blocks for People you look after, with icons where stored', async () => {
    const later = new Date('2026-10-24T16:00:00Z');
    prisma.blockedApp.findMany.mockResolvedValueOnce([
      row('riley', 'com.zhiliaoapp.musically', 'TikTok', 'sam', later),
      row('jordan', 'com.roblox.client', 'Roblox', 'alex'),
      row('riley', 'com.roblox.client', 'Roblox', 'alex'),
    ]);
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 'alex', name: 'Alex' },
      { id: 'sam', name: 'Sam' },
    ]);
    prisma.appIcon.findMany.mockResolvedValueOnce([{ app: 'com.roblox.client' }]);
    const byKid = await blockedAppsByKid(H, ['riley', 'jordan']);
    expect(byKid.get('riley')).toEqual([
      { app: 'com.zhiliaoapp.musically', label: 'TikTok', icon: false, byName: 'Sam', at: later.toISOString() },
      { app: 'com.roblox.client', label: 'Roblox', icon: true, byName: 'Alex', at: at.toISOString() },
    ]);
    expect(byKid.get('jordan')).toHaveLength(1);
    expect(prisma.blockedApp.findMany).toHaveBeenCalledWith({
      where: { householdId: H, userId: { in: ['riley', 'jordan'] } },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.appIcon.findMany).toHaveBeenCalledWith({
      where: { householdId: H, app: { in: ['com.zhiliaoapp.musically', 'com.roblox.client'] } },
      select: { app: true },
    });
  });

  it('looks nothing up for nobody, or when nothing is blocked', async () => {
    expect((await blockedAppsByKid(H, [])).size).toBe(0);
    expect(prisma.blockedApp.findMany).not.toHaveBeenCalled();
    expect((await blockedAppsByKid(H, ['riley'])).size).toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(await isBlockedFor([], 'com.roblox.client')).toBe(false);
    expect(prisma.blockedApp.count).not.toHaveBeenCalled();
  });

  it('says whether an app is blocked for any of some children, and names every blocked app once', async () => {
    prisma.blockedApp.count.mockResolvedValueOnce(1);
    expect(await isBlockedFor(['riley', 'jordan'], 'com.roblox.client')).toBe(true);
    expect(prisma.blockedApp.count).toHaveBeenCalledWith({
      where: { userId: { in: ['riley', 'jordan'] }, app: 'com.roblox.client' },
    });
    prisma.blockedApp.findMany.mockResolvedValueOnce([{ app: 'a' }, { app: 'b' }, { app: 'a' }]);
    expect(await blockedAppNames(prisma as never, H)).toEqual(['a', 'b']);
  });
});
