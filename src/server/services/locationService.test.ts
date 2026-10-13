import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(async (args: { data: { locationSharing?: string; liveChecks?: boolean } }) => ({
      locationSharing: args.data.locationSharing ?? null,
      liveChecks: args.data.liveChecks ?? null,
    })),
  },
  mapPlace: { findFirst: vi.fn(), findMany: vi.fn(async (): Promise<unknown[]> => []) },
  memberLocation: {
    findUnique: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  shoppingList: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const liveChecks = { closeExpiredLiveChecks: vi.fn(), endLiveChecksOn: vi.fn() };
vi.mock('@/server/services/liveCheckService', () => liveChecks);
const dashboard = {
  myTasksDueToday: vi.fn(async () => ({ count: 3, titles: ['Dishes', 'Take out the bins', 'Feed the cat'] })),
};
vi.mock('@/server/services/dashboardService', () => dashboard);
const serverAdmin = { getHouseholdFeatures: vi.fn(async () => ['tasks', 'location']) };
vi.mock('@/server/services/serverAdminService', () => serverAdmin);

const { listPresence, reportPresence, updateLocationConsent } = await import('./locationService');

const now = new Date(Date.UTC(2026, 9, 12, 18, 0));
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const sharing = { locationSharing: 'on', liveChecks: false };
const costco = { id: 'cstore00000000000000000001', name: 'Costco', kind: 'store', shoppingListIds: ['groceries', 'hardware'] };

describe('updateLocationConsent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('turns sharing on for the member', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: null, liveChecks: null });
    expect(await updateLocationConsent('u1', { sharing: 'on' })).toEqual({ sharing: 'on', liveChecks: false });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
    expect(prisma.memberLocation.deleteMany).not.toHaveBeenCalled();
    expect(liveChecks.endLiveChecksOn).not.toHaveBeenCalled();
  });

  it('forgets where they were when they stop sharing', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'on', liveChecks: true });
    await updateLocationConsent('u1', { sharing: 'off' });
    expect(prisma.memberLocation.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    // A check running on them ends first (so its last fix isn't left behind).
    expect(liveChecks.endLiveChecksOn).toHaveBeenCalledWith('u1', { sharing: 'off', liveChecks: false });
  });

  it('ends a running check when they turn live checks off', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'on', liveChecks: true });
    // Prisma leaves fields the update doesn't name as they were.
    prisma.user.update.mockResolvedValueOnce({ locationSharing: 'on', liveChecks: false });
    await updateLocationConsent('u1', { liveChecks: false });
    expect(liveChecks.endLiveChecksOn).toHaveBeenCalledWith('u1', { sharing: 'on', liveChecks: false });
    expect(prisma.memberLocation.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to turn off sharing that is required', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'required', liveChecks: true });
    await expect(updateLocationConsent('u1', { sharing: 'off' })).rejects.toThrow(/required/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('reportPresence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(sharing);
    prisma.mapPlace.findFirst.mockResolvedValue(costco);
    prisma.memberLocation.findUnique.mockResolvedValue({ state: 'place', placeId: 'home', at: minutesAgo(60) });
    prisma.shoppingList.findMany.mockResolvedValue([
      { id: 'groceries', name: 'Groceries', _count: { items: 6 } },
      { id: 'hardware', name: 'Hardware', _count: { items: 0 } },
    ]);
  });

  const arrive = (at = minutesAgo(1)) => ({ placeId: costco.id, transition: 'enter' as const, at, lat: 41.9, lng: -87.7 });

  it('refuses a member who does not share', async () => {
    prisma.user.findUnique.mockResolvedValue({ locationSharing: 'off', liveChecks: false });
    await expect(reportPresence('h1', 'u1', arrive(), now)).rejects.toThrow(/sharing is off/);
    expect(prisma.memberLocation.upsert).not.toHaveBeenCalled();
  });

  it('records the arrival and reminds about the lists with something to buy', async () => {
    const result = await reportPresence('h1', 'u1', arrive(), now);
    expect(result.reminder).toEqual({
      placeId: costco.id,
      placeName: 'Costco',
      lists: [{ id: 'groceries', name: 'Groceries', openItems: 6 }],
    });
    expect(prisma.memberLocation.upsert.mock.calls[0][0].update).toMatchObject({
      state: 'place',
      placeId: costco.id,
      lat: 41.9,
    });
  });

  it('updates presence but does not remind for a late report', async () => {
    const result = await reportPresence('h1', 'u1', arrive(minutesAgo(40)), now);
    expect(result.reminder).toBeNull();
    expect(prisma.memberLocation.upsert).toHaveBeenCalled();
  });

  it('does not remind again while they are still there', async () => {
    prisma.memberLocation.findUnique.mockResolvedValue({ state: 'place', placeId: costco.id, at: minutesAgo(5) });
    expect((await reportPresence('h1', 'u1', arrive(), now)).reminder).toBeNull();
    expect(prisma.memberLocation.upsert).not.toHaveBeenCalled();
  });

  it('has nothing to say when every list is bought', async () => {
    prisma.shoppingList.findMany.mockResolvedValue([{ id: 'groceries', name: 'Groceries', _count: { items: 0 } }]);
    expect((await reportPresence('h1', 'u1', arrive(), now)).reminder).toBeNull();
  });

  it('keeps the battery even when the place is old news', async () => {
    prisma.memberLocation.findUnique
      .mockResolvedValueOnce({ state: 'place', placeId: costco.id, at: minutesAgo(10) }) // already there
      .mockResolvedValueOnce({ householdId: 'h1', batteryAt: minutesAgo(60) }); // saveBattery
    const result = await reportPresence(
      'h1',
      'u1',
      { placeId: costco.id, transition: 'enter', at: minutesAgo(1), battery: { pct: 30, charging: false } },
      now,
    );
    expect(result).toEqual({ reminder: null, home: null });
    expect(prisma.memberLocation.upsert).not.toHaveBeenCalled();
    expect(prisma.memberLocation.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { batteryPct: 30, batteryCharging: false, batteryAt: minutesAgo(1) },
    });
  });

  it('pulls a report from a fast phone clock back to now', async () => {
    prisma.memberLocation.findUnique.mockResolvedValue(null);
    await reportPresence('h1', 'u1', arrive(new Date(now.getTime() + 3_600_000)), now);
    expect(prisma.memberLocation.upsert.mock.calls[0][0].create.at).toEqual(now);
  });

  describe('arriving home', () => {
    const home = { id: 'chome0000000000000000001', name: 'Home', kind: 'home', shoppingListIds: [] };
    const arriveHome = (at = minutesAgo(1)) => ({ ...arrive(at), placeId: home.id });
    beforeEach(() => {
      prisma.mapPlace.findFirst.mockResolvedValue(home);
      // Coming back from the store.
      prisma.memberLocation.findUnique.mockResolvedValue({ state: 'away', placeId: null, at: minutesAgo(90) });
    });

    it('says how many of their chores are due, and remembers that it did', async () => {
      const result = await reportPresence('h1', 'u1', arriveHome(), now);
      expect(result).toEqual({ reminder: null, home: { count: 3, titles: ['Dishes', 'Take out the bins', 'Feed the cat'] } });
      expect(dashboard.myTasksDueToday).toHaveBeenCalledWith('h1', 'u1', now);
      expect(prisma.memberLocation.update).toHaveBeenCalledWith({ where: { userId: 'u1' }, data: { homeReminderAt: now } });
    });

    it('stays quiet when nothing is due', async () => {
      dashboard.myTasksDueToday.mockResolvedValueOnce({ count: 0, titles: [] });
      expect((await reportPresence('h1', 'u1', arriveHome(), now)).home).toBeNull();
      expect(prisma.memberLocation.update).not.toHaveBeenCalled();
    });

    it('does not remind again within four hours', async () => {
      prisma.memberLocation.findUnique.mockResolvedValue({
        state: 'away', placeId: null, at: minutesAgo(20), homeReminderAt: minutesAgo(60),
      });
      expect((await reportPresence('h1', 'u1', arriveHome(), now)).home).toBeNull();
      expect(dashboard.myTasksDueToday).not.toHaveBeenCalled();
    });

    it('stays quiet for a late report, or when the household has no Tasks', async () => {
      expect((await reportPresence('h1', 'u1', arriveHome(minutesAgo(30)), now)).home).toBeNull();
      serverAdmin.getHouseholdFeatures.mockResolvedValueOnce(['location']);
      expect((await reportPresence('h1', 'u1', arriveHome(), now)).home).toBeNull();
      expect(dashboard.myTasksDueToday).not.toHaveBeenCalled();
    });

    it('never comes with a store reminder, and a store never brings it', async () => {
      prisma.mapPlace.findFirst.mockResolvedValue(costco);
      const atStore = await reportPresence('h1', 'u1', arrive(), now);
      expect(atStore.home).toBeNull();
      expect(atStore.reminder).not.toBeNull();
    });
  });

  it('404s a place outside the household', async () => {
    prisma.mapPlace.findFirst.mockResolvedValue(null);
    await expect(reportPresence('h1', 'u1', arrive(), now)).rejects.toThrow(/not found/);
  });
});

describe('listPresence', () => {
  const row = (userId: string, name: string, extra: Record<string, unknown>) => ({
    userId,
    at: minutesAgo(30),
    lat: 45.1,
    lng: -93.2,
    accuracyM: 20,
    user: { name, locationSharing: 'on', householdId: 'h1' },
    ...extra,
  });

  beforeEach(() => {
    prisma.mapPlace.findMany.mockResolvedValue([{ id: costco.id, name: 'Costco', kind: 'store' }]);
  });

  it('shows someone at a place at the place, never their exact spot', async () => {
    prisma.memberLocation.findMany.mockResolvedValue([row('u1', 'Alex', { state: 'place', placeId: costco.id })]);
    const [alex] = await listPresence('h1');
    expect(alex).toMatchObject({ state: 'place', place: { id: costco.id }, point: null });
  });

  it('shows the phone battery once there is a reading', async () => {
    prisma.memberLocation.findMany.mockResolvedValue([
      row('u1', 'Alex', { state: 'away', placeId: null, batteryPct: 42, batteryCharging: true, batteryAt: minutesAgo(5) }),
      row('u2', 'Sam', { state: 'away', placeId: null }),
    ]);
    const [alex, sam] = await listPresence('h1');
    expect(alex.battery).toEqual({ pct: 42, charging: true, at: minutesAgo(5).toISOString() });
    expect(sam.battery).toBeNull();
  });

  it('gives someone away the point they left from', async () => {
    prisma.memberLocation.findMany.mockResolvedValue([row('u1', 'Alex', { state: 'away', placeId: null })]);
    const [alex] = await listPresence('h1');
    expect(alex).toMatchObject({ state: 'away', place: null, point: { lat: 45.1, lng: -93.2, accuracyM: 20 } });
  });

  it('leaves out anyone who stopped sharing or moved household', async () => {
    prisma.memberLocation.findMany.mockResolvedValue([
      row('u1', 'Alex', { state: 'away', placeId: null, user: { name: 'Alex', locationSharing: 'off', householdId: 'h1' } }),
      row('u2', 'Sam', { state: 'away', placeId: null, user: { name: 'Sam', locationSharing: 'on', householdId: 'h2' } }),
    ]);
    expect(await listPresence('h1')).toEqual([]);
  });
});
