import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findUnique: vi.fn(async (): Promise<unknown> => ({ shareAppUsage: true })) },
  appUsageDay: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  appIcon: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { findIcon, forgetUsage, reportIcons, reportUsage, usageNamesApp, usageSummaries } = await import(
  './appUsageService'
);

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
    // Sent again within the day (hourly), it replaces what was stored.
    expect(today.update).toEqual({ householdId: 'h1', totalMinutes: 40, apps: today.create.apps });
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

  it('never stores more minutes than a day has', async () => {
    await reportUsage('h1', 'mia', { days: [{ day: '2026-10-12', totalMinutes: 5000, apps: [] }] }, now);
    expect(prisma.appUsageDay.upsert.mock.calls[0][0].create.totalMinutes).toBe(1440);
  });

  it('does nothing at all when every day is out of range', async () => {
    await reportUsage('h1', 'mia', { days: [{ day: '2020-01-01', totalMinutes: 5, apps: [] }] }, now);
    expect(prisma.appUsageDay.upsert).not.toHaveBeenCalled();
    expect(prisma.appUsageDay.deleteMany).not.toHaveBeenCalled();
  });
});

describe('usageSummaries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gives each member their newest day and its top three apps, saying which have an icon', async () => {
    const at = new Date('2026-10-12T17:00:00Z');
    const apps = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => ({ app: `a${i}`, label: `App ${i}`, minutes: 50 - i })));
    prisma.appUsageDay.findMany.mockResolvedValueOnce([
      { userId: 'mia', day: '2026-10-12', totalMinutes: 125, apps: apps(5), updatedAt: at },
      { userId: 'mia', day: '2026-10-11', totalMinutes: 300, apps: apps(1), updatedAt: at },
      { userId: 'riley', day: '2026-10-12', totalMinutes: 0, apps: 'not json', updatedAt: at },
    ]);
    prisma.appIcon.findMany.mockResolvedValueOnce([{ app: 'a1' }]);
    const out = await usageSummaries('h1', ['mia', 'riley']);
    expect(out.get('mia')).toEqual({
      day: '2026-10-12',
      totalMinutes: 125,
      top: [
        { app: 'a0', label: 'App 0', minutes: 50, icon: false },
        { app: 'a1', label: 'App 1', minutes: 49, icon: true },
        { app: 'a2', label: 'App 2', minutes: 48, icon: false },
      ],
      updatedAt: at.toISOString(),
    });
    expect(out.get('riley')?.top).toEqual([]);
    // Only the shown apps are looked up, in this household.
    expect(prisma.appIcon.findMany).toHaveBeenCalledWith({
      where: { householdId: 'h1', app: { in: ['a0', 'a1', 'a2'] } },
      select: { app: true },
    });
  });
});

const png = (extra = 10) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(extra).fill(0)]);
const stored = (...apps: string[]) => ({ apps: JSON.stringify(apps.map((app) => ({ app, label: app, minutes: 5 }))) });

describe('app icons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ shareAppUsage: true });
    prisma.appUsageDay.findMany.mockResolvedValue([]);
    prisma.appIcon.findMany.mockResolvedValue([]);
  });

  it('a report answers which of its apps have no icon yet', async () => {
    prisma.appIcon.findMany.mockResolvedValueOnce([{ app: yt.app }]);
    const out = await reportUsage(
      'h1',
      'mia',
      {
        days: [
          {
            day: '2026-10-12',
            totalMinutes: 40,
            apps: [
              { ...yt, minutes: 30 },
              { app: 'com.roblox.client', label: 'Roblox', minutes: 10 },
              { app: 'com.example.zero', label: 'Zero', minutes: 0 },
            ],
          },
        ],
      },
      now,
    );
    // Zero minutes isn't stored, so its icon isn't wanted either.
    expect(out).toEqual({ missingIcons: ['com.roblox.client'] });
    expect(prisma.appIcon.findMany).toHaveBeenCalledWith({
      where: { householdId: 'h1', app: { in: [yt.app, 'com.roblox.client'] } },
      select: { app: true },
    });
  });

  it('a report forgets icons no stored day names any more', async () => {
    prisma.appUsageDay.findMany.mockResolvedValueOnce([stored(yt.app), stored(yt.app, 'com.roblox.client')]);
    await reportUsage('h1', 'mia', { days: [{ day: '2026-10-12', totalMinutes: 5, apps: [] }] }, now);
    expect(prisma.appUsageDay.findMany).toHaveBeenCalledWith({ where: { householdId: 'h1' }, select: { apps: true } });
    expect(prisma.appIcon.deleteMany).toHaveBeenCalledWith({
      where: { householdId: 'h1', app: { notIn: [yt.app, 'com.roblox.client'] } },
    });
  });

  it('stores only real, small PNGs, and only for apps in the member’s own usage', async () => {
    prisma.appUsageDay.findMany.mockResolvedValueOnce([stored(yt.app, 'com.roblox.client', 'com.big')]);
    const out = await reportIcons('h1', 'mia', {
      icons: [
        { app: yt.app, png: png().toString('base64') },
        { app: 'com.roblox.client', png: Buffer.from('GIF89a not a png').toString('base64') },
        { app: 'com.big', png: png(33 * 1024).toString('base64') },
        { app: 'com.not.theirs', png: png().toString('base64') },
      ],
    });
    expect(out).toEqual({ saved: 1 });
    expect(prisma.appUsageDay.findMany).toHaveBeenCalledWith({ where: { userId: 'mia' }, select: { apps: true } });
    expect(prisma.appIcon.upsert).toHaveBeenCalledTimes(1);
    const call = prisma.appIcon.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ householdId_app: { householdId: 'h1', app: yt.app } });
    expect(Buffer.from(call.create.png)).toEqual(png());
    expect(call.update).toEqual({ png: call.create.png });
  });

  it('refuses icons while their usage isn’t shared', async () => {
    prisma.user.findUnique.mockResolvedValue({ shareAppUsage: null });
    await expect(reportIcons('h1', 'mia', { icons: [{ app: yt.app, png: png().toString('base64') }] })).rejects.toThrow(
      /isn’t shared/,
    );
    expect(prisma.appIcon.upsert).not.toHaveBeenCalled();
  });

  it('forgetting a member’s usage takes the icons only they named', async () => {
    prisma.appUsageDay.findMany.mockResolvedValueOnce([stored('com.roblox.client')]);
    await forgetUsage(prisma as never, 'h1', ['mia']);
    expect(prisma.appUsageDay.deleteMany).toHaveBeenCalledWith({ where: { userId: { in: ['mia'] } } });
    expect(prisma.appIcon.deleteMany).toHaveBeenCalledWith({
      where: { householdId: 'h1', app: { notIn: ['com.roblox.client'] } },
    });
  });

  it('finds an icon in the household, and whether someone’s usage names an app', async () => {
    prisma.appIcon.findUnique.mockResolvedValueOnce({ png: png() });
    expect(Buffer.from((await findIcon('h1', yt.app))!)).toEqual(png());
    expect(prisma.appIcon.findUnique).toHaveBeenCalledWith({
      where: { householdId_app: { householdId: 'h1', app: yt.app } },
      select: { png: true },
    });
    expect(await findIcon('h1', 'com.none')).toBeNull();

    prisma.appUsageDay.findMany.mockResolvedValueOnce([stored('com.roblox.client'), stored(yt.app)]);
    expect(await usageNamesApp(['mia'], yt.app)).toBe(true);
    prisma.appUsageDay.findMany.mockResolvedValueOnce([stored('com.roblox.client')]);
    expect(await usageNamesApp(['mia'], yt.app)).toBe(false);
    expect(await usageNamesApp([], yt.app)).toBe(false);
  });
});
