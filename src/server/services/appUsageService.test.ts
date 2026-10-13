import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findUnique: vi.fn(async (): Promise<unknown> => ({ shareAppUsage: true })) },
  appUsageDay: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { reportUsage, usageSummaries } = await import('./appUsageService');

const yt = { app: 'com.google.android.youtube', label: 'YouTube' };
const now = new Date('2026-10-12T18:00:00Z');

describe('reportUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ shareAppUsage: true });
  });

  it('is refused while their app usage is not shared', async () => {
    prisma.user.findUnique.mockResolvedValue({ shareAppUsage: null });
    await expect(
      reportUsage('h1', 'mia', { days: [{ day: '2026-10-12', totalMinutes: 5, apps: [] }] }, now),
    ).rejects.toThrow(/isn’t shared/);
    expect(prisma.appUsageDay.upsert).not.toHaveBeenCalled();
  });

  it('stores each day tidied, and forgets days older than two weeks', async () => {
    await reportUsage('h1', 'mia', {
      days: [
        { day: '2026-10-11', totalMinutes: 90, apps: [{ ...yt, minutes: 90 }] },
        {
          day: '2026-10-12',
          totalMinutes: 40,
          apps: [
            { app: 'com.roblox.client', label: 'Roblox', minutes: 10 },
            { ...yt, minutes: 25 },
            { ...yt, minutes: 5 },
            { app: 'com.example.zero', label: 'Zero', minutes: 0 },
          ],
        },
      ],
    }, now);
    expect(prisma.appUsageDay.upsert).toHaveBeenCalledTimes(2);
    const today = prisma.appUsageDay.upsert.mock.calls[1][0];
    expect(today.where).toEqual({ userId_day: { userId: 'mia', day: '2026-10-12' } });
    expect(JSON.parse(today.create.apps)).toEqual([
      { ...yt, minutes: 30 },
      { app: 'com.roblox.client', label: 'Roblox', minutes: 10 },
    ]);
    // 14 days kept, counting the newest: 2026-09-29 to 2026-10-12.
    expect(prisma.appUsageDay.deleteMany).toHaveBeenCalledWith({ where: { userId: 'mia', day: { lt: '2026-09-29' } } });
  });
});

describe('reportUsage dates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ shareAppUsage: true });
  });

  it('ignores a day far from the server’s date, so a wrong phone clock can’t wipe the real ones', async () => {
    await reportUsage(
      'h1',
      'mia',
      {
        days: [
          { day: '2099-01-01', totalMinutes: 5, apps: [] },
          { day: '2026-10-13', totalMinutes: 5, apps: [] },
        ],
      },
      now,
    );
    // Only 2026-10-13 (a phone east of UTC can already be there) was kept,
    // and the window counts back from it, not from 2099.
    expect(prisma.appUsageDay.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.appUsageDay.deleteMany).toHaveBeenCalledWith({ where: { userId: 'mia', day: { lt: '2026-09-30' } } });
  });

  it('does nothing at all when every day is out of range', async () => {
    await reportUsage('h1', 'mia', { days: [{ day: '2020-01-01', totalMinutes: 5, apps: [] }] }, now);
    expect(prisma.appUsageDay.upsert).not.toHaveBeenCalled();
    expect(prisma.appUsageDay.deleteMany).not.toHaveBeenCalled();
  });
});

describe('usageSummaries', () => {
  it('gives each member their newest day and its top three apps', async () => {
    const at = new Date('2026-10-12T17:00:00Z');
    const apps = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ app: `a${i}`, label: `App ${i}`, minutes: 50 - i })));
    prisma.appUsageDay.findMany.mockResolvedValueOnce([
      { userId: 'mia', day: '2026-10-12', totalMinutes: 125, apps: apps(5), updatedAt: at },
      { userId: 'mia', day: '2026-10-11', totalMinutes: 300, apps: apps(1), updatedAt: at },
      { userId: 'riley', day: '2026-10-12', totalMinutes: 0, apps: 'not json', updatedAt: at },
    ]);
    const out = await usageSummaries(['mia', 'riley']);
    expect(out.get('mia')).toEqual({
      day: '2026-10-12',
      totalMinutes: 125,
      top: [
        { label: 'App 0', minutes: 50 },
        { label: 'App 1', minutes: 49 },
        { label: 'App 2', minutes: 48 },
      ],
      updatedAt: at.toISOString(),
    });
    expect(out.get('riley')?.top).toEqual([]);
  });
});
