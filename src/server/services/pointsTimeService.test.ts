import { beforeEach, describe, expect, it, vi } from 'vitest';

const tx = {
  extraTime: { create: vi.fn(async () => ({ id: 'x1' })) },
  notification: { createMany: vi.fn() },
};
const prisma = {
  pointAward: { groupBy: vi.fn(async (): Promise<unknown[]> => []) },
  extraTime: {
    groupBy: vi.fn(async (): Promise<unknown[]> => []),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  pointsForTime: { findUnique: vi.fn(async (): Promise<unknown> => null) },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  appLimit: { count: vi.fn(async () => 1) },
  user: { findFirst: vi.fn(async (): Promise<unknown> => ({ name: 'Riley' })) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const push = { pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);
const admin = { isFeatureEnabled: vi.fn(async () => true) };
vi.mock('@/server/services/serverAdminService', () => admin);

const { buyExtraTime, myExtraTime, nearToday, phoneExtraTime, phonePointsRule, pointsBalances } = await import(
  './pointsTimeService'
);

const H = 'h1';
const DAY = '2026-10-12';
const now = new Date('2026-10-12T18:00:00Z');
const rule = { householdId: H, minutesPerPoint: 5, dailyCap: 30 };
const supervised = () =>
  prisma.supervision.findMany.mockResolvedValue([
    { supervisorId: 'alex', supervisor: { role: 'adult' }, supervised: { role: 'child' } },
    { supervisorId: 'sam', supervisor: { role: 'manager' }, supervised: { role: 'child' } },
  ]);
/** Riley has earned [earned] and spent [spent] points (hundredths). */
const balance = (earned: number, spent = 0) => {
  prisma.pointAward.groupBy.mockResolvedValueOnce([{ userId: 'riley', _sum: { pointsCenti: earned } }]);
  prisma.extraTime.groupBy.mockResolvedValueOnce(spent ? [{ userId: 'riley', _sum: { pointsCenti: spent } }] : []);
};

describe('points for screen time', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([]);
    prisma.pointsForTime.findUnique.mockResolvedValue(null);
    prisma.extraTime.findMany.mockResolvedValue([]);
    prisma.appLimit.count.mockResolvedValue(1);
  });

  it('balances earned points (not voided) against points spent, for each member', async () => {
    prisma.pointAward.groupBy.mockResolvedValueOnce([{ userId: 'riley', _sum: { pointsCenti: 1500 } }]);
    prisma.extraTime.groupBy.mockResolvedValueOnce([{ userId: 'riley', _sum: { pointsCenti: 300 } }]);
    const out = await pointsBalances(prisma as never, H, ['riley', 'mia']);
    expect(out).toEqual(new Map([['riley', 1200], ['mia', 0]]));
    expect(prisma.pointAward.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { householdId: H, userId: { in: ['riley', 'mia'] }, OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] },
      }),
    );
    expect(prisma.extraTime.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, userId: { in: ['riley', 'mia'] }, pointsCenti: { gt: 0 } } }),
    );
  });

  it('gives the phone each day’s minutes around today, and the rule only with Points on', async () => {
    prisma.extraTime.findMany.mockResolvedValueOnce([
      { day: DAY, minutes: 15 },
      { day: '2026-10-11', minutes: 30 },
      { day: DAY, minutes: 10 },
    ]);
    expect(await phoneExtraTime(H, 'riley', now)).toEqual([
      { day: '2026-10-11', minutes: 30 },
      { day: DAY, minutes: 25 },
    ]);
    expect(prisma.extraTime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, userId: 'riley', day: { gte: '2026-10-11', lte: '2026-10-13' } } }),
    );
    prisma.pointsForTime.findUnique.mockResolvedValue(rule);
    expect(await phonePointsRule(H, 'riley')).toEqual({ minutesPerPoint: 5, dailyCap: 30 });
    admin.isFeatureEnabled.mockResolvedValueOnce(false);
    expect(await phonePointsRule(H, 'riley')).toBeNull();
    expect(nearToday('2026-10-14', now)).toBe(false);
  });

  it('shows a child what they can buy, and nothing while no adult looks after them', async () => {
    prisma.pointsForTime.findUnique.mockResolvedValue(rule);
    prisma.extraTime.findMany.mockResolvedValue([
      { minutes: 15, pointsCenti: 300 },
      { minutes: 10, pointsCenti: 0 },
    ]);
    supervised();
    balance(1500, 300);
    expect(await myExtraTime(H, 'riley', DAY)).toEqual({
      available: true,
      hasLimits: true,
      minutesPerPoint: 5,
      dailyCap: 30,
      balanceCenti: 1200,
      day: DAY,
      bought: 15,
      given: 10,
    });
    prisma.supervision.findMany.mockResolvedValue([]);
    balance(1500, 300);
    expect(await myExtraTime(H, 'riley', DAY)).toMatchObject({ available: false, minutesPerPoint: null, dailyCap: null });
  });

  it('buys minutes: spends the points, logs it, tells each supervisor and wakes the phones', async () => {
    prisma.pointsForTime.findUnique.mockResolvedValue(rule);
    supervised();
    balance(1000);
    balance(1000, 300);
    const result = await buyExtraTime(H, 'riley', { minutes: 15, day: DAY }, now);
    expect(tx.extraTime.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'riley', day: DAY, minutes: 15, pointsCenti: 300, byId: 'riley' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'riley', message: 'spent 3 points on 15 min more screen time' }),
      tx,
    );
    const rows = tx.notification.createMany.mock.calls[0][0].data as Record<string, unknown>[];
    expect(rows.map((r) => r.userId)).toEqual(['alex', 'sam']);
    expect(rows[0]).toMatchObject({
      type: 'extra_time',
      title: 'Riley spent 3 points on 15 min more',
      subjectId: 'riley',
      dedupeKey: 'extra_time:x1:alex',
    });
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex', 'sam'] }, 'reminder');
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['riley'] }, 'supervision');
    expect(result.balanceCenti).toBe(700);
  });

  it('refuses with a reason: off, no limits, over the cap, too few points, or a wrong date', async () => {
    const buy = (minutes: number, day = DAY) => buyExtraTime(H, 'riley', { minutes, day }, now);
    balance(1000);
    await expect(buy(15)).rejects.toThrow(/can’t buy screen time for you/);
    prisma.pointsForTime.findUnique.mockResolvedValue(rule);
    supervised();
    prisma.appLimit.count.mockResolvedValue(0);
    balance(1000);
    await expect(buy(15)).rejects.toThrow(/no daily limits/);
    prisma.appLimit.count.mockResolvedValue(1);
    prisma.extraTime.findMany.mockResolvedValue([{ minutes: 20, pointsCenti: 400 }]);
    balance(1000, 400);
    await expect(buy(15)).rejects.toThrow(/You can buy 10 min more today/);
    prisma.extraTime.findMany.mockResolvedValue([]);
    balance(250);
    await expect(buy(15)).rejects.toThrow(/That costs 3 points, and you have 2\.5/);
    await expect(buy(15, '2026-10-20')).rejects.toThrow(/date looks wrong/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
