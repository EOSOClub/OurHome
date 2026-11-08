import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  phoneStatus: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  user: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findUnique: vi.fn(async (): Promise<unknown> => null),
  },
  notification: {
    findMany: vi.fn(async (): Promise<{ id: string; dedupeKey: string | null }[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    create: vi.fn(),
  },
};
const { Prisma } = await import('@prisma/client');
const duplicateKey = () => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { pushSync: vi.fn(), pingInstall: vi.fn(async () => 'sent') };
vi.mock('@/server/services/pushService', () => push);
const isFeatureEnabled = vi.fn(async () => true);
vi.mock('@/server/services/serverAdminService', () => ({ isFeatureEnabled }));
const battery = { saveBattery: vi.fn() };
vi.mock('@/server/services/batteryService', () => battery);
const blocks = { phoneBlocks: vi.fn(async (): Promise<unknown[]> => []) };
vi.mock('@/server/services/appBlockService', () => blocks);
const limits = {
  phoneLimits: vi.fn(async (): Promise<unknown[]> => []),
  reportLimitsReached: vi.fn(async () => ({ told: 0 })),
};
vi.mock('@/server/services/appLimitService', () => limits);
const schedules = { phoneSchedules: vi.fn(async (): Promise<unknown[]> => []) };
vi.mock('@/server/services/appScheduleService', () => schedules);
const pointsTime = {
  phoneExtraTime: vi.fn(async (): Promise<unknown[]> => []),
  phonePointsRule: vi.fn(async (): Promise<unknown> => null),
};
vi.mock('@/server/services/pointsTimeService', () => pointsTime);
const parentPin = { reportPinEvents: vi.fn(async () => ({ told: 0 })) };
vi.mock('@/server/services/parentPinService', () => parentPin);

const {
  checkIn,
  clearPhoneWatches,
  phoneSetup,
  phoneSummaries,
  PING_AFTER_MS,
  recordStream,
  refreshPhoneAlerts,
  setServerStartedAt,
  STREAM_BOOT_GRACE_MS,
} = await import('./phoneStatusService');
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
    expect(await checkIn(H, 'mia', base, now)).toEqual({ stayConnectedRequired: true, blockedApps: [], appLimits: [], schedules: [], extraTime: [], pointsForTime: null, webFilter: null });
    // A link whose supervisor became a guest no longer counts.
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'guest')]);
    expect(await checkIn(H, 'mia', base, now)).toEqual({ stayConnectedRequired: false, blockedApps: [], appLimits: [], schedules: [], extraTime: [], pointsForTime: null, webFilter: null });
    prisma.supervision.findMany.mockResolvedValue([]);
    expect(await checkIn(H, 'alex', base, now)).toEqual({ stayConnectedRequired: false, blockedApps: [], appLimits: [], schedules: [], extraTime: [], pointsForTime: null, webFilter: null });
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
      appLimits: [],
      schedules: [],
      extraTime: [],
      pointsForTime: null,
      webFilter: null,
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

  it('answers a looked-after phone with its daily limits, and passes on the limits it used up', async () => {
    const youtube = { app: 'com.google.android.youtube', label: 'YouTube', minutes: 60, by: 'Alex' };
    limits.phoneLimits.mockResolvedValue([youtube]);
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    const reached = { day: '2026-10-12', apps: ['com.google.android.youtube', '*'] };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    expect((await checkIn(H, 'mia', { ...base, limitsReached: reached }, now)).appLimits).toEqual([youtube]);
    expect(limits.phoneLimits).toHaveBeenCalledWith(H, 'mia');
    expect(limits.reportLimitsReached).toHaveBeenCalledWith(H, 'mia', reached, now);
    // Nobody looks after them: no limits, and nobody to tell.
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([]);
    expect((await checkIn(H, 'mia', { ...base, limitsReached: reached }, now)).appLimits).toEqual([]);
    expect(limits.phoneLimits).not.toHaveBeenCalled();
    expect(limits.reportLimitsReached).not.toHaveBeenCalled();
    limits.phoneLimits.mockResolvedValue([]);
  });

  it('passes on what the parent PIN did, only while someone looks after them', async () => {
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    const pinEvents = [{ id: 'event-0001', kind: 'opened', atMs: now.getTime(), screen: 'app_info' }];
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    await checkIn(H, 'mia', { ...base, pinEvents }, now);
    expect(parentPin.reportPinEvents).toHaveBeenCalledWith(H, 'mia', pinEvents, now);
    vi.clearAllMocks();
    await checkIn(H, 'mia', { ...base, pinEvents: [] }, now);
    expect(parentPin.reportPinEvents).not.toHaveBeenCalled();
    prisma.supervision.findMany.mockResolvedValue([]);
    await checkIn(H, 'mia', { ...base, pinEvents }, now);
    expect(parentPin.reportPinEvents).not.toHaveBeenCalled();
  });

  it('answers a looked-after phone with its schedules, and nobody else’s phone', async () => {
    const bedtime = { id: 's1', name: 'Bedtime', days: [0, 1], start: 1260, end: 420, allowed: [], by: 'Alex' };
    schedules.phoneSchedules.mockResolvedValue([bedtime]);
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    expect((await checkIn(H, 'mia', base, now)).schedules).toEqual([bedtime]);
    expect(schedules.phoneSchedules).toHaveBeenCalledWith(H, 'mia');
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([]);
    expect((await checkIn(H, 'mia', base, now)).schedules).toEqual([]);
    expect(schedules.phoneSchedules).not.toHaveBeenCalled();
    schedules.phoneSchedules.mockResolvedValue([]);
  });

  it('answers a looked-after phone with its extra minutes and what a point buys', async () => {
    const extra = [{ day: '2026-10-12', minutes: 30 }];
    pointsTime.phoneExtraTime.mockResolvedValue(extra);
    pointsTime.phonePointsRule.mockResolvedValue({ minutesPerPoint: 5, dailyCap: 30 });
    const base = { installId: 'install-123', locationAlways: true, notifications: true };
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    const answer = await checkIn(H, 'mia', base, now);
    expect(answer.extraTime).toEqual(extra);
    expect(answer.pointsForTime).toEqual({ minutesPerPoint: 5, dailyCap: 30 });
    expect(pointsTime.phoneExtraTime).toHaveBeenCalledWith(H, 'mia', now);
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([]);
    const unsupervised = await checkIn(H, 'mia', base, now);
    expect(unsupervised.extraTime).toEqual([]);
    expect(unsupervised.pointsForTime).toBeNull();
    expect(pointsTime.phoneExtraTime).not.toHaveBeenCalled();
    pointsTime.phoneExtraTime.mockResolvedValue([]);
    pointsTime.phonePointsRule.mockResolvedValue(null);
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

    // "unlocked" stays while the guard is still off and goes once it's back on.
    prisma.phoneStatus.findUnique.mockResolvedValue({ userId: 'mia', emergencyUnlockStage: 'unlocked' });
    await checkIn(H, 'mia', { ...base, uninstallGuard: false }, now);
    expect(stored()).not.toHaveProperty('emergencyUnlockStage');
    await checkIn(H, 'mia', { ...base, uninstallGuard: true }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });
    // Any other milestone with no unlock running is over.
    prisma.phoneStatus.findUnique.mockResolvedValue({ userId: 'mia', emergencyUnlockStage: '1h_left' });
    await checkIn(H, 'mia', { ...base, uninstallGuard: false }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });

    // A shared tablet: another child signs in where Mia's unlock was. Hers
    // isn't theirs, so it starts fresh for them (P7, owner 2026-11-08), and
    // their supervisors aren't told about Mia's unlock.
    prisma.phoneStatus.findUnique.mockResolvedValue({ userId: 'mia', emergencyUnlockStage: 'unlocked' });
    await checkIn(H, 'leo', { ...base, uninstallGuard: false }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });
    prisma.phoneStatus.findUnique.mockResolvedValue({ userId: 'mia', emergencyUnlockStage: '2h_elapsed' });
    await checkIn(H, 'leo', { ...base, uninstallGuard: false, emergencyUnlockReadyAtMs: readyAt }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: null });
    // A milestone the phone sends now is the phone's word, whoever signed in.
    await checkIn(H, 'leo', { ...base, uninstallGuard: false, emergencyUnlockStage: '1h_left', emergencyUnlockReadyAtMs: readyAt }, now);
    expect(stored()).toMatchObject({ emergencyUnlockStage: '1h_left' });
    prisma.phoneStatus.findUnique.mockResolvedValue(null);

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

describe('alerts that stay put', () => {
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  const phone = { userId: 'mia', installId: 'phone', locationAlways: true, notifications: true, deviceName: 'Phone' };
  const tablet = { userId: 'mia', installId: 'tablet', locationAlways: true, notifications: false, deviceName: 'Tablet' };

  beforeEach(() => {
    vi.clearAllMocks();
    clearStreams();
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.createMany.mockReset();
    prisma.notification.create.mockReset();
  });

  it('keeps an alert another of the child’s phones still has, when the other one checks in', async () => {
    // The tablet (notifications off) raised it; now the phone is the freshest.
    prisma.phoneStatus.findMany.mockResolvedValue([
      { ...phone, lastSeenAt: now },
      { ...tablet, lastSeenAt: minutesAgo(40) },
    ]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:notifications_off:mia:alex' }]);
    await refreshPhoneAlerts(H, now, ['mia']);
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('judges every device (P3, owner 2026-11-08): a quiet tablet beside a fresh phone is said, and keeps what it last had', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      { ...phone, lastSeenAt: now },
      { ...tablet, lastSeenAt: minutesAgo(9 * 60) },
    ]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:notifications_off:mia:alex' }]);
    await refreshPhoneAlerts(H, now, ['mia']);
    // The tablet's notifications alert isn't known to be fixed: it stays.
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:quiet:mia:alex',
    ]);
  });

  it('a quiet main phone raises its alert while a tablet keeps checking in', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      { ...phone, lastSeenAt: minutesAgo(9 * 60) },
      { ...tablet, notifications: true, lastSeenAt: now },
    ]);
    await refreshPhoneAlerts(H, now, ['mia']);
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:quiet:mia:alex',
    ]);
  });

  it('a problem on a device that is heard from is raised, not only kept', async () => {
    // The tablet (notifications off) checks in now; the phone did a little earlier and is fine.
    prisma.phoneStatus.findMany.mockResolvedValue([
      { ...phone, lastSeenAt: now },
      { ...tablet, lastSeenAt: minutesAgo(40) },
    ]);
    await refreshPhoneAlerts(H, now, ['mia']);
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:notifications_off:mia:alex',
    ]);
  });

  it('the summary lists every device, freshest first, each judged on its own', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      { ...phone, lastSeenAt: minutesAgo(9 * 60) },
      { ...tablet, lastSeenAt: now },
    ]);
    const summary = (await phoneSummaries(H, [{ id: 'mia', locationSharing: 'on' }], now)).get('mia');
    // The card's own line is still the freshest device (older apps read only that).
    expect(summary?.deviceName).toBe('Tablet');
    expect(summary?.devices).toEqual([
      { installId: 'tablet', deviceName: 'Tablet', lastSeenAt: now.toISOString(), problems: ['notifications_off'], lastKnown: [] },
      { installId: 'phone', deviceName: 'Phone', lastSeenAt: minutesAgo(9 * 60).toISOString(), problems: ['quiet'], lastKnown: [] },
    ]);
  });

  it('keeps the other alerts while the phone is quiet, so none comes back as new when it returns', async () => {
    const filtered = { ...mia, webFilter: 'family' } as typeof mia;
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'adult', filtered)]);
    const quiet = { ...phone, privateDns: 'off', lastSeenAt: minutesAgo(9 * 60) };
    prisma.phoneStatus.findMany.mockResolvedValue([quiet]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:web_filter_off:mia:alex' }]);
    await refreshPhoneAlerts(H, now);
    // Quiet is raised; the filter alert, not known to be fixed, stays.
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:quiet:mia:alex',
    ]);

    // Back next morning, filter still off: only the quiet alert goes, nothing is pushed again.
    vi.clearAllMocks();
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...quiet, lastSeenAt: now }]);
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n1', dedupeKey: 'phone:web_filter_off:mia:alex' },
      { id: 'n2', dedupeKey: 'phone:quiet:mia:alex' },
    ]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n2'] } } });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('still clears an alert while the phone is quiet once its requirement is turned off', async () => {
    // The web filter was required (and off on the phone); now it isn't required.
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'adult', mia)]);
    const quiet = { ...phone, privateDns: 'off', lastSeenAt: minutesAgo(9 * 60) };
    prisma.phoneStatus.findMany.mockResolvedValue([quiet]);
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:web_filter_off:mia:alex' }]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n1'] } } });
  });

  it('takes an alert written at the same moment by another check as already done', async () => {
    prisma.supervision.findMany.mockResolvedValue([link('alex'), link('sam')]);
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, locationAlways: false, lastSeenAt: now }]);
    prisma.notification.createMany.mockRejectedValueOnce(duplicateKey());
    prisma.notification.create.mockRejectedValueOnce(duplicateKey()).mockResolvedValueOnce({});
    const pinEvents = [{ id: 'event-0001', kind: 'opened', atMs: now.getTime(), screen: 'app_info' }];
    await checkIn(H, 'mia', { installId: 'phone', locationAlways: false, notifications: true, pinEvents }, now);
    expect(prisma.notification.create.mock.calls.map(([a]) => (a as { data: { dedupeKey: string } }).data.dedupeKey)).toEqual([
      'phone:location_off:mia:alex',
      'phone:location_off:mia:sam',
    ]);
    // The rest of the check-in still ran.
    expect(parentPin.reportPinEvents).toHaveBeenCalled();
  });

  it('still fails on any other error', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, locationAlways: false, lastSeenAt: now }]);
    prisma.notification.createMany.mockRejectedValueOnce(new Error('down'));
    await expect(refreshPhoneAlerts(H, now)).rejects.toThrow('down');
  });
});

describe('after the server restarts', () => {
  // Mia's phone holds a Stay connected stream; it opened 11:35, its last check-in was 11:20.
  const bootAt = new Date('2026-10-12T12:00:00Z');
  const at = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00Z`);
  const watched = {
    userId: 'mia',
    installId: 'i1',
    locationAlways: true,
    deviceName: null,
    stayConnected: true,
    batteryUnrestricted: true,
    lastSeenAt: at('11:20'),
    streamAt: at('11:35'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearStreams();
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.notification.createMany.mockReset();
    prisma.phoneStatus.findMany.mockResolvedValue([watched]);
    setServerStartedAt(bootAt);
  });
  afterEach(() => setServerStartedAt(new Date(0)));

  it('gives a connected phone time to reconnect before calling it quiet', async () => {
    await refreshPhoneAlerts(H, at('12:01'));
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    // An alert from before the restart is neither dropped nor raised again.
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:quiet:mia:alex' }]);
    await refreshPhoneAlerts(H, at('12:01'));
    expect(prisma.notification.deleteMany).not.toHaveBeenCalled();
  });

  it('still alerts once the grace is over and it hasn’t come back', async () => {
    await refreshPhoneAlerts(H, new Date(bootAt.getTime() + STREAM_BOOT_GRACE_MS + 60_000));
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:quiet:mia:alex',
    ]);
  });

  it('a phone that never used a stream is judged as before', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...watched, stayConnected: null, streamAt: null, lastSeenAt: at('03:00') }]);
    await refreshPhoneAlerts(H, at('12:01'));
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:quiet:mia:alex',
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

  it('clears a quiet alert as soon as the phone reconnects', async () => {
    prisma.notification.findFirst.mockResolvedValueOnce({ id: 'n1' });
    prisma.notification.findMany.mockResolvedValue([{ id: 'n1', dedupeKey: 'phone:quiet:mia:alex' }]);
    prisma.phoneStatus.findMany.mockResolvedValue([
      { userId: 'mia', installId: 'i1', locationAlways: true, deviceName: null, stayConnected: true, batteryUnrestricted: true, lastSeenAt: hoursAgo(1), streamAt: now },
    ]);
    await recordStream(H, 'mia', 'i1', { opened: true }, now);
    expect(prisma.notification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, type: 'phone_alert', subjectId: 'mia' } }),
    );
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['n1'] } } });
  });

  it('does no extra work on reconnect when there is no alert to clear', async () => {
    await recordStream(H, 'mia', 'i1', { opened: true }, now);
    expect(prisma.supervision.findMany).not.toHaveBeenCalled();
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

  it('a quiet phone says the silence, and what its last report showed wrong (P5, owner 2026-11-08)', async () => {
    const phone = { userId: 'mia', installId: 'i1', locationAlways: false, notifications: false, deviceName: null };
    const kid = { id: 'mia', locationSharing: 'required' };
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, lastSeenAt: hoursAgo(30) }]);
    expect((await phoneSummaries(H, [kid], now)).get('mia')).toMatchObject({
      problems: ['quiet'],
      lastKnown: ['notifications_off', 'location_off'],
    });
    // Under the rules as they are now: sharing no longer required, so location isn't listed.
    expect((await phoneSummaries(H, [{ ...kid, locationSharing: 'on' }], now)).get('mia')?.lastKnown).toEqual([
      'notifications_off',
    ]);
    // Heard from: its problems are the problems, nothing "last known".
    prisma.phoneStatus.findMany.mockResolvedValue([{ ...phone, lastSeenAt: hoursAgo(1) }]);
    expect((await phoneSummaries(H, [kid], now)).get('mia')).toMatchObject({
      problems: ['notifications_off', 'location_off'],
      lastKnown: [],
    });
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
    expect(Object.values(setup.required)).not.toContain(true);
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
        webFilter: false,
        keepRunning: true,
        preventUninstall: false,
        batteryUnrestricted: true,
      },
      webFilter: null,
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mia', householdId: H } }));
  });

  it('asks for the chosen web filter, with the hostname their Private DNS needs', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([link('alex')]);
    prisma.user.findFirst.mockResolvedValueOnce({ locationSharing: 'on', webFilter: 'adult' });
    const setup = await phoneSetup(H, 'mia');
    expect(setup.required.webFilter).toBe(true);
    expect(setup.webFilter).toEqual({ filter: 'adult', label: 'Adult sites only', hostname: 'family.cloudflare-dns.com' });
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

describe('web filter on check-in', () => {
  const base = { installId: 'install-123', locationAlways: true, notifications: true };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([link('alex')]);
    prisma.notification.findMany.mockResolvedValue([]);
    prisma.phoneStatus.findMany.mockResolvedValue([]);
  });

  it('stores what Private DNS is set to, and keeps it when the phone couldn’t read it', async () => {
    await checkIn(H, 'mia', { ...base, privateDns: 'family-filter-dns.cleanbrowsing.org' }, now);
    expect(prisma.phoneStatus.upsert.mock.calls[0][0].update.privateDns).toBe('family-filter-dns.cleanbrowsing.org');
    await checkIn(H, 'mia', base, now);
    expect(prisma.phoneStatus.upsert.mock.calls[1][0].update).not.toHaveProperty('privateDns');
  });

  it('answers a looked-after phone with its filter’s hostname, and nobody else’s', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ webFilter: 'family' });
    expect((await checkIn(H, 'mia', base, now)).webFilter).toBe('family-filter-dns.cleanbrowsing.org');
    prisma.supervision.findMany.mockResolvedValue([]);
    expect((await checkIn(H, 'mia', base, now)).webFilter).toBeNull();
  });

  it('alerts supervisors while the phone isn’t using the chosen filter', async () => {
    prisma.phoneStatus.findMany.mockResolvedValue([
      { userId: 'mia', lastSeenAt: hoursAgo(1), locationAlways: true, privateDns: 'off', deviceName: null },
    ]);
    prisma.supervision.findMany.mockResolvedValue([link('alex', 'adult', { ...mia, webFilter: 'family' } as typeof mia)]);
    await refreshPhoneAlerts(H, now);
    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { dedupeKey: string }) => r.dedupeKey)).toEqual([
      'phone:web_filter_off:mia:alex',
    ]);
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
    // The limits it used up today: its own date and the apps ("*" for all apps).
    const reached = { day: '2026-10-12', apps: ['com.google.android.youtube', '*'] };
    expect(phoneCheckInSchema.parse({ ...base, limitsReached: reached }).limitsReached).toEqual(reached);
    expect(() => phoneCheckInSchema.parse({ ...base, limitsReached: { day: 'today', apps: [] } })).toThrow();
  });

  it('takes up to 20 parent PIN events, of any kind (the service drops the ones it does not know)', async () => {
    const { phoneCheckInSchema } = await import('@/lib/validation/phone');
    const event = (i: number) => ({ id: `event-${1000 + i}`, kind: i % 2 ? 'wrong_pin' : 'newer_kind', atMs: 5 });
    const events = Array.from({ length: 20 }, (_, i) => event(i));
    expect(phoneCheckInSchema.parse({ ...base, pinEvents: events }).pinEvents).toEqual(events);
    expect(() => phoneCheckInSchema.parse({ ...base, pinEvents: [...events, event(21)] })).toThrow();
    expect(() => phoneCheckInSchema.parse({ ...base, pinEvents: [{ ...event(1), id: 'short' }] })).toThrow();
  });
});
