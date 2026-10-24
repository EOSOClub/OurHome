import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  phoneStatus: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  user: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  notification: {
    findMany: vi.fn(async (): Promise<{ id: string; dedupeKey: string | null }[]> => []),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { pushSync: vi.fn(), pingInstall: vi.fn(async () => 'sent') };
vi.mock('@/server/services/pushService', () => push);
const isFeatureEnabled = vi.fn(async () => true);
vi.mock('@/server/services/serverAdminService', () => ({ isFeatureEnabled }));
const battery = { saveBattery: vi.fn() };
vi.mock('@/server/services/batteryService', () => battery);
const blocks = { phoneBlocks: vi.fn(async (): Promise<unknown[]> => []) };
vi.mock('@/server/services/appBlockService', () => blocks);

const { checkIn, clearPhoneWatches, phoneSetup, phoneSummaries, PING_AFTER_MS, recordStream, refreshPhoneAlerts } =
  await import('./phoneStatusService');
const { addStream, clearStreams } = await import('@/server/push/streamHub');

const now = new Date('2026-10-12T18:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const H = 'h1';
const mia: { id: string; name: string; role: string; locationSharing: string; shareAppUsage?: boolean | null } = {
  id: 'mia',
  name: 'Mia',
  role: 'child',
  locationSharing: 'required',
};
const link = (supervisorId: string, role = 'adult', kid = mia) => ({ supervisorId, supervisor: { role }, supervised: kid });

describe('phone alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([link('alex'), link('sam')]);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.phoneStatus.findMany.mockResolvedValue([]);
  });

  it('alerts every supervisor once when a child’s phone goes quiet', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([{ userId: 'mia', lastSeenAt: hoursAgo(9), locationAlways: true, deviceName: null }]);
    await refreshPhoneAlerts(H, now);
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { userId: string; dedupeKey: string }) => [r.userId, r.dedupeKey])).toEqual([
      ['alex', 'phone:quiet:mia:alex'],
      ['sam', 'phone:quiet:mia:sam'],
    ]);
    expect(rows[0]).toMatchObject({ type: 'phone_alert', subjectType: 'phone', subjectId: 'mia' });
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex', 'sam'] }, 'reminder');
  });

  it('does not alert again while the alert is still there, read or not', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([{ userId: 'mia', lastSeenAt: hoursAgo(9), locationAlways: true, deviceName: null }]);
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n1', dedupeKey: 'phone:quiet:mia:alex' },
      { id: 'n2', dedupeKey: 'phone:quiet:mia:sam' },
    ]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('removes the alert once the phone is back, or for someone who no longer supervises', async () => {
    prisma.supervision.findMany.mockResolvedValue([link('alex'), link('gran', 'teen')]);
    prisma.phoneStatus.findMany.mockResolvedValue([{ userId: 'mia', lastSeenAt: hoursAgo(1), locationAlways: false, deviceName: null }]);
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n1', dedupeKey: 'phone:quiet:mia:alex' },
      { id: 'n2', dedupeKey: 'phone:location_off:mia:gran' },
    ]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n1', 'n2'] } } });
    // Back, but location is off while required: that's the new alert, for Alex only.
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:location_off:mia:alex',
    ]);
  });

  it('alerts when Usage access goes off while their app usage is shared, and not while it isn’t', async () => {
    const phone = { userId: 'mia', lastSeenAt: hoursAgo(1), locationAlways: true, usageAccess: false, deviceName: null };
    prisma.phoneStatus.findMany.mockResolvedValue([phone]);
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'adult', { ...mia, shareAppUsage: true })]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:usage_off:mia:alex',
    ]);

    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'adult', { ...mia, shareAppUsage: null })]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('a check-in records the phone and refreshes only that member’s alerts', async () => {
    await checkIn(H, 'mia', { installId: 'install-123', appVersion: '0.2.0', locationAlways: true, notifications: true }, now);
    expect(prisma.phoneStatus.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installId: 'install-123' },
        update: expect.objectContaining({ userId: 'mia', lastSeenAt: now, locationAlways: true }),
      }),
    );
    expect(prisma.supervision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, supervisedId: { in: ['mia'] } } }),
    );
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, type: 'phone_alert', subjectId: { in: ['mia'] } } }),
    );
  });

  it('tells the phone to Stay connected while an adult looks after its member, and only then', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    expect(await checkIn(H, 'mia', base, now)).toEqual({ stayConnectedRequired: true, blockedApps: [] });
    // A link whose supervisor became a guest no longer counts.
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'guest')]);
    expect(await checkIn(H, 'mia', base, now)).toEqual({ stayConnectedRequired: false, blockedApps: [] });
    prisma.supervision.findMany.mockResolvedValue([]);
    expect(await checkIn(H, 'alex', base, now)).toEqual({ stayConnectedRequired: false, blockedApps: [] });
  });

  it('answers a looked-after phone with its blocked apps, and keeps what it always leaves open', async () => {
    const roblox = { app: 'com.roblox.client', label: 'Roblox', by: 'Alex' };
    blocks.phoneBlocks.mockResolvedValue([roblox]);
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    const allowed = ['com.google.android.dialer', 'com.google.android.apps.messaging', 'com.google.android.dialer'];
    expect(await checkIn(H, 'mia', { ...base, alwaysAllowed: allowed }, now)).toEqual({
      stayConnectedRequired: true,
      blockedApps: [roblox],
    });
    expect(blocks.phoneBlocks).toHaveBeenCalledWith(H, 'mia');
    expect(prisma.phoneStatus.upsert.mock.calls[0][0].update.alwaysAllowed).toEqual([
      'com.google.android.dialer',
      'com.google.android.apps.messaging',
    ]);
    // A phone that sends none (nobody looked after them then, or an older app) leaves what's stored.
    await checkIn(H, 'mia', base, now);
    expect(prisma.phoneStatus.upsert.mock.calls[1][0].update).not.toHaveProperty('alwaysAllowed');
    // Nobody looks after them: no blocks, whatever is still stored.
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([]);
    expect((await checkIn(H, 'mia', base, now)).blockedApps).toEqual([]);
    expect(blocks.phoneBlocks).not.toHaveBeenCalled();
    blocks.phoneBlocks.mockResolvedValue([]);
  });

  it('records how alerts reach the phone, never trusting a phone clock ahead of the server', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    await checkIn(
      H,
      'mia',
      {
        ...base,
        lastPushAtMs: now.getTime() + 3_600_000,
        lastPushVia: 'connection',
        batteryUnrestricted: false,
        standbyBucket: 40,
        stayConnected: true,
        closeGuard: false,
      },
      now,
    );
    expect(prisma.phoneStatus.upsert.mock.calls[0][0].update).toMatchObject({
      lastPushAt: now,
      lastPushVia: 'connection',
      batteryUnrestricted: false,
      standbyBucket: 40,
      stayConnected: true,
      closeGuard: false,
    });

    // An older app says none of it: stored as unknown, not as false.
    vi.clearAllMocks();
    await checkIn(H, 'mia', base, now);
    expect(prisma.phoneStatus.upsert.mock.calls[0][0].update).toMatchObject({
      lastPushAt: null,
      lastPushVia: null,
      batteryUnrestricted: null,
      standbyBucket: null,
      stayConnected: null,
      closeGuard: null,
    });
  });

  it('stores the uninstall guard and keeps the emergency unlock’s milestone between milestones', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    const stored = () => prisma.phoneStatus.upsert.mock.calls.at(-1)?.[0].update;
    const readyAt = now.getTime() + 5 * 3_600_000;

    await checkIn(H, 'mia', { ...base, uninstallGuard: false, emergencyUnlockStage: 'started', emergencyUnlockReadyAtMs: readyAt }, now);
    expect(stored()).toMatchObject({ uninstallGuard: false, emergencyUnlockStage: 'started' });
    // An hourly check-in while it runs: the milestone stays as it was.
    await checkIn(H, 'mia', { ...base, uninstallGuard: false, emergencyUnlockReadyAtMs: readyAt }, now);
    expect(stored()).not.toHaveProperty('emergencyUnlockStage');
    // None running: cleared.
    await checkIn(H, 'mia', { ...base, uninstallGuard: true }, now);
    expect(stored()).toMatchObject({ uninstallGuard: true, emergencyUnlockStage: null });

    // "unlocked" stays while the guard is still off, and goes once it's back on.
    prisma.phoneStatus.findUnique.mockResolvedValue({ emergencyUnlockStage: 'unlocked' });
    await checkIn(H, 'mia', { ...base, uninstallGuard: false }, now);
    expect(stored()).not.toHaveProperty('emergencyUnlockStage');
    await checkIn(H, 'mia', { ...base, uninstallGuard: true }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });
    // Any other milestone with no unlock running is over.
    prisma.phoneStatus.findUnique.mockResolvedValue({ emergencyUnlockStage: '1h_left' });
    await checkIn(H, 'mia', { ...base, uninstallGuard: false }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });

    // An older app says nothing about it.
    await checkIn(H, 'mia', base, now);
    expect(stored()).toMatchObject({ uninstallGuard: null, emergencyUnlockStage: null });
  });

  it('alerts each emergency unlock milestone once, replacing the one before', async () => {
    const phone = { userId: 'mia', lastSeenAt: hoursAgo(1), locationAlways: true, deviceName: null, uninstallGuard: false };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, emergencyUnlockStage: '2h_elapsed' }]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:emergency_unlock_started:mia:alex' }]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n1'] } } });
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:emergency_unlock_2h:mia:alex',
    ]);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex'] }, 'reminder');
  });

  it('stores the status a supervised phone sends, and its last word before switching off', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    await checkIn(H, 'mia', { ...base, status: { battery: 4, charging: false, network: 'cellular', signal: 1 }, shuttingDown: true }, now);
    expect(prisma.phoneStatus.upsert.mock.calls[0][0].update).toMatchObject({
      batteryPct: 4,
      batteryCharging: false,
      network: 'cellular',
      signalLevel: 1,
      statusAt: now,
      shutdownAt: now,
      pushGoneAt: null,
    });
    // No status sent: the last one is kept, and the shutdown mark goes.
    vi.clearAllMocks();
    await checkIn(H, 'mia', base, now);
    const update = prisma.phoneStatus.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('batteryPct');
    expect(update.shutdownAt).toBeNull();
  });

  it('keeps the Map’s battery fresh from a check-in’s status, before judging its alerts', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    await checkIn(H, 'mia', { ...base, status: { battery: 14, charging: true, network: 'wifi' } }, now);
    expect(battery.saveBattery).toHaveBeenCalledWith(H, 'mia', { pct: 14, charging: true }, now, now);
    expect(battery.saveBattery.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.notification.findMany.mock.invocationCallOrder[0],
    );
    // Charging not said counts as not charging; no battery or no status: nothing to save.
    vi.clearAllMocks();
    await checkIn(H, 'mia', { ...base, status: { battery: 50 } }, now);
    expect(battery.saveBattery).toHaveBeenCalledWith(H, 'mia', { pct: 50, charging: false }, now, now);
    vi.clearAllMocks();
    await checkIn(H, 'mia', { ...base, status: { network: 'none' } }, now);
    await checkIn(H, 'mia', base, now);
    expect(battery.saveBattery).not.toHaveBeenCalled();
  });

  it('alerts supervisors when the battery runs low, and drops the alert once it charges', async () => {
    const phone = { userId: 'mia', installId: 'i1', lastSeenAt: hoursAgo(0.2), statusAt: hoursAgo(0.2), locationAlways: true, deviceName: null };
    prisma.supervision.findMany.mockResolvedValue([link('alex'), link('sam')]);
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, batteryPct: 12, batteryCharging: false }]);
    await refreshPhoneAlerts(H, now);
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual(['phone:battery_low:mia:alex', 'phone:battery_low:mia:sam']);
    expect(rows[0]).toMatchObject({ title: 'Mia’s phone battery is low' });
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex', 'sam'] }, 'reminder');

    vi.clearAllMocks();
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, batteryPct: 13, batteryCharging: true }]);
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n1', dedupeKey: 'phone:battery_low:mia:alex' },
      { id: 'n2', dedupeKey: 'phone:battery_low:mia:sam' },
    ]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n1', 'n2'] } } });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('alerts supervisors while battery saving still holds OurHome back', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      { userId: 'mia', installId: 'i1', lastSeenAt: hoursAgo(1), locationAlways: true, batteryUnrestricted: false, deviceName: null },
    ]);
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:battery_restricted:mia:alex',
    ]);
  });
});

describe('a stream that closes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearStreams();
    clearPhoneWatches();
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.phoneStatus.findMany.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('pings a supervised phone that stays away, then checks its alerts without waiting for the sweep', async () => {
    await recordStream(H, 'mia', 'i1', { opened: false }, now);
    expect(prisma.phoneStatus.updateMany.mock.calls[0][0]).toMatchObject({
      where: { installId: 'i1', userId: 'mia' },
      data: { streamAt: now },
    });
    await vi.advanceTimersByTimeAsync(PING_AFTER_MS);
    expect(push.pingInstall).toHaveBeenCalledWith(H, 'mia', 'i1');
    prisma.supervision.findMany.mockClear();
    await vi.advanceTimersByTimeAsync(21 * 60_000);
    // refreshPhoneAlerts ran for Mia only.
    const [args] = prisma.supervision.findMany.mock.calls[0] as unknown as [{ where: unknown }];
    expect(args.where).toMatchObject({ supervisedId: { in: ['mia'] } });
  });

  it('forgets the follow-up when the phone is back, and never follows an adult', async () => {
    await recordStream(H, 'mia', 'i1', { opened: false }, now);
    await recordStream(H, 'mia', 'i1', { opened: true, status: { battery: 50 } }, now);
    expect(prisma.phoneStatus.updateMany.mock.calls[1][0].data).toMatchObject({
      streamAt: now,
      batteryPct: 50,
      shutdownAt: null,
      pushGoneAt: null,
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(push.pingInstall).not.toHaveBeenCalled();

    prisma.supervision.findMany.mockResolvedValue([]);
    await recordStream(H, 'alex', 'i2', { opened: false }, now);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(push.pingInstall).not.toHaveBeenCalled();
  });
});

describe('phone summaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStreams();
  });

  it('says whether the phone is connected right now, by its install', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      {
        userId: 'mia',
        installId: 'i1',
        lastSeenAt: hoursAgo(1),
        locationAlways: true,
        deviceName: 'Pixel',
        lastPushAt: hoursAgo(2),
        stayConnected: true,
      },
    ]);
    const kids = [{ id: 'mia', locationSharing: 'on' }];
    expect((await phoneSummaries(H, kids, now)).get('mia')).toMatchObject({
      stayConnected: true,
      connected: false,
      lastPushAt: hoursAgo(2).toISOString(),
    });
    const remove = addStream({ householdId: H, userId: 'mia', installId: 'i1', send: () => {} });
    expect((await phoneSummaries(H, kids, now)).get('mia')?.connected).toBe(true);
    remove();
    // Another household's connection with the same install id doesn't count.
    addStream({ householdId: 'h2', userId: 'mia', installId: 'i1', send: () => {} });
    expect((await phoneSummaries(H, kids, now)).get('mia')?.connected).toBe(false);
  });

  it('counts its stream as last seen, the same moment its quiet alert counts from', async () => {
    const phone = { userId: 'mia', installId: 'i1', lastSeenAt: hoursAgo(1), locationAlways: true, deviceName: null };
    const kids = [{ id: 'mia', locationSharing: 'on' }];
    const streamAt = new Date(now.getTime() - 25 * 60_000);
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, stayConnected: true, batteryUnrestricted: true, streamAt }]);
    expect((await phoneSummaries(H, kids, now)).get('mia')).toMatchObject({
      lastSeenAt: streamAt.toISOString(),
      problems: ['quiet'],
    });
    // A stream older than its check-in doesn't move it back.
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, streamAt: hoursAgo(3) }]);
    expect((await phoneSummaries(H, kids, now)).get('mia')?.lastSeenAt).toBe(hoursAgo(1).toISOString());
  });

  it('judges each child on the protections their supervisors require, and notifications', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      {
        userId: 'mia',
        installId: 'i1',
        lastSeenAt: hoursAgo(1),
        locationAlways: true,
        notifications: false,
        closeGuard: false,
        uninstallGuard: false,
        batteryUnrestricted: false,
        deviceName: null,
      },
    ]);
    const kid = { id: 'mia', locationSharing: 'on' };
    expect((await phoneSummaries(H, [kid], now)).get('mia')?.problems).toEqual([
      'notifications_off',
      'battery_restricted',
      'close_guard_off',
      'uninstall_guard_off',
    ]);
    const relaxed = { ...kid, requireKeepRunning: false, requireBatteryUnrestricted: false };
    expect((await phoneSummaries(H, [relaxed], now)).get('mia')?.problems).toEqual([
      'notifications_off',
      'uninstall_guard_off',
    ]);
  });
});

describe('what a phone must set up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
  });

  it('asks nothing of a member nobody looks after', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([]);
    prisma.user.findFirst.mockResolvedValueOnce({ locationSharing: 'required', shareAppUsage: true });
    const setup = await phoneSetup(H, 'mia');
    expect(setup.supervised).toBe(false);
    expect(Object.values(setup.required).every((v) => v === false)).toBe(true);
  });

  it('asks a supervised child for notifications, what their settings need, and the chosen protections', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([link('alex')]);
    prisma.user.findFirst.mockResolvedValueOnce({
      locationSharing: 'required',
      shareAppUsage: true,
      requirePreventUninstall: false,
    });
    expect(await phoneSetup(H, 'mia')).toEqual({
      supervised: true,
      required: {
        notifications: true,
        location: true,
        usageAccess: true,
        keepRunning: true,
        preventUninstall: false,
        batteryUnrestricted: true,
      },
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mia', householdId: H } }));
  });

  it('leaves location out when it isn’t required, or the household doesn’t use Location', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([link('alex')]);
    prisma.user.findFirst.mockResolvedValueOnce({ locationSharing: 'on', shareAppUsage: null });
    expect((await phoneSetup(H, 'mia')).required).toMatchObject({ location: false, usageAccess: false });

    prisma.supervision.findMany.mockResolvedValueOnce([link('alex')]);
    prisma.user.findFirst.mockResolvedValueOnce({ locationSharing: 'required' });
    isFeatureEnabled.mockResolvedValueOnce(false);
    expect((await phoneSetup(H, 'mia')).required.location).toBe(false);
  });

  it('asks nothing when the supervisor is no longer an adult', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([link('jo', 'teen')]);
    prisma.user.findFirst.mockResolvedValueOnce({ locationSharing: 'required' });
    expect((await phoneSetup(H, 'mia')).supervised).toBe(false);
  });
});

describe('check-in fields', () => {
  const base = { installId: 'install-123', locationAlways: true, notifications: true };

  it('takes every emergency unlock milestone the app sends, and drops one it doesn’t know instead of refusing', async () => {
    const { phoneCheckInSchema } = await import('@/lib/validation/phone');
    for (const stage of ['started', '30m_left', '2h_elapsed', '3h_elapsed', '6h_elapsed', '1h_left', 'unlocked']) {
      expect(phoneCheckInSchema.parse({ ...base, emergencyUnlockStage: stage }).emergencyUnlockStage).toBe(stage);
    }
    const parsed = phoneCheckInSchema.parse({ ...base, emergencyUnlockStage: '12h_left', emergencyUnlockReadyAtMs: 5 });
    expect(parsed.emergencyUnlockStage).toBeUndefined();
    expect(parsed.emergencyUnlockReadyAtMs).toBe(5);
  });

  it('takes up to 50 always-open apps', async () => {
    const { phoneCheckInSchema } = await import('@/lib/validation/phone');
    const apps = Array.from({ length: 50 }, (_, i) => `com.example.app${i}`);
    expect(phoneCheckInSchema.parse({ ...base, alwaysAllowed: apps }).alwaysAllowed).toHaveLength(50);
    expect(() => phoneCheckInSchema.parse({ ...base, alwaysAllowed: [...apps, 'one.more'] })).toThrow();
    expect(() => phoneCheckInSchema.parse({ ...base, alwaysAllowed: [''] })).toThrow();
  });
});
