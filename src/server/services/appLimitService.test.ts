import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => ({ name: 'Riley' })),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  appLimit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    count: vi.fn(async () => 0),
  },
  appIcon: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  notification: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    createMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);

const { appLimitsByKid, isLimitedFor, limitedAppNames, phoneLimits, reportLimitsReached } = await import(
  './appLimitService'
);

const H = 'h1';
const YT = 'com.google.android.youtube';
const now = new Date('2026-10-12T18:00:00Z');
const link = (supervisorId: string, role = 'adult') => ({
  supervisorId,
  supervisor: { role },
  supervised: { role: 'child' },
});

describe('daily limits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers the phone with each limit and who set it (null once they have left)', async () => {
    prisma.appLimit.findMany.mockResolvedValueOnce([
      { app: '*', label: 'All apps', minutes: 180, setById: 'alex' },
      { app: YT, label: 'YouTube', minutes: 60, setById: 'gone' },
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'alex', name: 'Alex Morgan' }]);
    expect(await phoneLimits(H, 'riley')).toEqual([
      { app: '*', label: 'All apps', minutes: 180, by: 'Alex Morgan' },
      { app: YT, label: 'YouTube', minutes: 60, by: null },
    ]);
    expect(prisma.appLimit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, userId: 'riley' } }),
    );
  });

  it('lists each child’s limits for their page, with icons for apps only', async () => {
    const at = new Date('2026-10-12T17:00:00Z');
    prisma.appLimit.findMany.mockResolvedValueOnce([
      { userId: 'riley', app: '*', label: 'All apps', minutes: 180, setById: 'alex', updatedAt: at },
      { userId: 'riley', app: YT, label: 'YouTube', minutes: 60, setById: 'gone', updatedAt: at },
    ]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'alex', name: 'Alex' }]);
    prisma.appIcon.findMany.mockResolvedValueOnce([{ app: YT }]);
    const byKid = await appLimitsByKid(H, ['riley', 'mia']);
    expect(prisma.appIcon.findMany).toHaveBeenCalledWith({
      where: { householdId: H, app: { in: [YT] } },
      select: { app: true },
    });
    expect(byKid.get('riley')).toEqual([
      { app: '*', label: 'All apps', icon: false, minutes: 180, byName: 'Alex', at: at.toISOString() },
      { app: YT, label: 'YouTube', icon: true, minutes: 60, byName: 'Someone who has left', at: at.toISOString() },
    ]);
    expect(byKid.has('mia')).toBe(false);
    expect((await appLimitsByKid(H, [])).size).toBe(0);
  });

  it('knows which apps have a limit, never counting all apps as one', async () => {
    prisma.appLimit.count.mockResolvedValueOnce(1);
    expect(await isLimitedFor(['riley'], YT)).toBe(true);
    expect(await isLimitedFor(['riley'], '*')).toBe(false);
    expect(await isLimitedFor([], YT)).toBe(false);
    prisma.appLimit.findMany.mockResolvedValueOnce([{ app: YT }, { app: YT }]);
    expect(await limitedAppNames(prisma as never, H)).toEqual([YT]);
    expect(prisma.appLimit.findMany).toHaveBeenLastCalledWith({
      where: { householdId: H, app: { not: '*' } },
      select: { app: true },
    });
  });

  it('tells each supervisor once per limit and day, and wakes their phones', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([link('alex'), link('sam'), link('guesty', 'guest')]);
    prisma.appLimit.findMany.mockResolvedValueOnce([
      { app: YT, label: 'YouTube', minutes: 60 },
      { app: '*', label: 'All apps', minutes: 180 },
    ]);
    // Sam already heard about YouTube today.
    prisma.notification.findMany.mockResolvedValueOnce([{ dedupeKey: `limit:riley:${YT}:2026-10-12:sam` }]);
    const result = await reportLimitsReached(H, 'riley', { day: '2026-10-12', apps: [YT, '*', YT] }, now);
    expect(result).toEqual({ told: 3 });
    expect(prisma.appLimit.findMany).toHaveBeenCalledWith({
      where: { householdId: H, userId: 'riley', app: { in: [YT, '*'] } },
      select: { app: true, label: true, minutes: true },
    });
    const rows = prisma.notification.createMany.mock.calls[0][0].data as Record<string, unknown>[];
    expect(rows.map((r) => r.dedupeKey)).toEqual([
      `limit:riley:${YT}:2026-10-12:alex`,
      'limit:riley:*:2026-10-12:alex',
      'limit:riley:*:2026-10-12:sam',
    ]);
    expect(rows[0]).toMatchObject({
      userId: 'alex',
      type: 'limit_reached',
      title: 'Riley used up their YouTube time for today',
      subjectType: 'phone',
      subjectId: 'riley',
    });
    expect(rows[1].title).toBe('Riley used up their app time for today');
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex', 'sam'] }, 'reminder');
  });

  it('tells nobody about a limit since removed, a far-off day, or when all were told', async () => {
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.appLimit.findMany.mockResolvedValueOnce([]);
    expect(await reportLimitsReached(H, 'riley', { day: '2026-10-12', apps: [YT] }, now)).toEqual({ told: 0 });
    expect(await reportLimitsReached(H, 'riley', { day: '2026-10-20', apps: [YT] }, now)).toEqual({ told: 0 });
    prisma.appLimit.findMany.mockResolvedValueOnce([{ app: YT, label: 'YouTube', minutes: 60 }]);
    prisma.notification.findMany.mockResolvedValueOnce([{ dedupeKey: `limit:riley:${YT}:2026-10-12:alex` }]);
    expect(await reportLimitsReached(H, 'riley', { day: '2026-10-12', apps: [YT] }, now)).toEqual({ told: 0 });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
    prisma.supervision.findMany.mockResolvedValue([]);
  });
});
