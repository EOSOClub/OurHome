import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  phoneStatus: {
    upsert: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  notification: {
    findMany: vi.fn(async (): Promise<{ id: string; dedupeKey: string | null }[]> => []),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);
vi.mock('@/server/services/serverAdminService', () => ({ isFeatureEnabled: vi.fn(async () => true) }));

const { checkIn, refreshPhoneAlerts } = await import('./phoneStatusService');

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
});
