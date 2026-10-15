import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  pushDevice: {
    upsert: vi.fn(),
    findMany: vi.fn(async (): Promise<{ token: string; userId?: string; installId?: string | null }[]> => []),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  phoneStatus: { updateMany: vi.fn() },
  user: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const fcm = {
  isPushConfigured: vi.fn(() => true),
  sendData: vi.fn(async (): Promise<'sent' | 'invalid_token' | 'failed'> => 'sent'),
};
vi.mock('@/server/push/fcm', () => fcm);
vi.mock('@/server/services/permissionService', () => ({ membersWithAccess: vi.fn(async () => []) }));

const {
  canPush,
  forgetStaleDevices,
  pingInstall,
  PUSH_DEVICE_STALE_MS,
  pushSync,
  pushToMember,
  registerDevice,
  sendTestPush,
  syncPriority,
} = await import('./pushService');
const hub = await import('@/server/push/streamHub');

const H = 'h1';
/** Lets pushSync's fire-and-forget send finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  hub.clearStreams();
  fcm.isPushConfigured.mockReturnValue(true);
  prisma.pushDevice.findMany.mockResolvedValue([]);
});

describe('priority', () => {
  it('sends what the phone handles silently at normal priority, the rest high', () => {
    expect(syncPriority('map_places')).toBe('normal');
    expect(syncPriority('location')).toBe('normal');
    expect(syncPriority('usage')).toBe('normal');
    expect(syncPriority('supervision')).toBe('normal');
    expect(syncPriority('request')).toBe('high');
    expect(syncPriority('reminder')).toBe('high');
    expect(syncPriority('app_update')).toBe('high');
  });

  it('uses it for sync pushes', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([{ token: 't1' }]);
    pushSync(H, { userIds: ['mia'] }, 'map_places');
    await settle();
    expect(fcm.sendData).toHaveBeenCalledWith('t1', expect.objectContaining({ type: 'sync', reason: 'map_places' }), undefined, 'normal');
  });
});

describe('Stay connected streams', () => {
  it('get every push to their member, with the same id Firebase gets', async () => {
    const got: Record<string, string>[] = [];
    hub.addStream({ householdId: H, userId: 'mia', installId: 'i1', send: (d) => got.push(d) });
    hub.addStream({ householdId: H, userId: 'sam', installId: 'i2', send: () => got.push({ wrong: 'member' }) });
    hub.addStream({ householdId: 'h2', userId: 'mia', installId: 'i3', send: () => got.push({ wrong: 'household' }) });
    prisma.pushDevice.findMany.mockResolvedValue([{ token: 't1' }]);

    expect(await pushToMember(H, 'mia', { type: 'ring', ringerId: 'alex' }, { ttlSec: 60 })).toBe(2);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'ring', ringerId: 'alex' });
    expect(got[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fcm.sendData).toHaveBeenCalledWith('t1', got[0], 60, undefined);
  });

  it('work without Firebase, and say how many phones they reached', async () => {
    fcm.isPushConfigured.mockReturnValue(false);
    const got: Record<string, string>[] = [];
    hub.addStream({ householdId: H, userId: 'mia', installId: 'i1', send: (d) => got.push(d) });
    expect(await pushToMember(H, 'mia', { type: 'usage_refresh' })).toBe(1);
    expect(fcm.sendData).not.toHaveBeenCalled();

    pushSync(H, { userIds: ['mia'] }, 'request');
    await settle();
    expect(got.map((d) => d.type)).toEqual(['usage_refresh', 'sync']);
    expect(prisma.pushDevice.findMany).not.toHaveBeenCalled();
  });

  it('are left out once closed, and a stream that throws is dropped', async () => {
    fcm.isPushConfigured.mockReturnValue(false);
    const remove = hub.addStream({ householdId: H, userId: 'mia', installId: 'i1', send: () => {} });
    remove();
    expect(await pushToMember(H, 'mia', { type: 'test' })).toBe(0);
    hub.addStream({
      householdId: H,
      userId: 'mia',
      installId: 'i1',
      send: () => {
        throw new Error('closed');
      },
    });
    expect(await pushToMember(H, 'mia', { type: 'test' })).toBe(0);
    expect(hub.hasStreams(H)).toBe(false);
  });

  it('make pushing possible without Firebase, for that household or member only', () => {
    fcm.isPushConfigured.mockReturnValue(false);
    expect(canPush()).toBe(false);
    expect(canPush(H)).toBe(false);
    hub.addStream({ householdId: H, userId: 'mia', installId: 'i1', send: () => {} });
    expect(canPush(H)).toBe(true);
    expect(canPush(H, 'mia')).toBe(true);
    expect(canPush(H, 'sam')).toBe(false);
    expect(canPush('h2')).toBe(false);
    fcm.isPushConfigured.mockReturnValue(true);
    expect(canPush()).toBe(true);
  });
});

describe('test notification', () => {
  it('pushes to my own phones, at most once every 10 seconds', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([{ token: 't1' }]);
    expect(await sendTestPush(H, 'alex', 1_000_000)).toEqual({ reached: 1, firebase: true, connected: false, tooSoon: false });
    expect(fcm.sendData).toHaveBeenCalledWith('t1', expect.objectContaining({ type: 'test' }), 300, undefined);
    expect((await sendTestPush(H, 'alex', 1_005_000)).tooSoon).toBe(true);
    expect(fcm.sendData).toHaveBeenCalledTimes(1);
    expect((await sendTestPush(H, 'alex', 1_011_000)).tooSoon).toBe(false);
  });
});

describe('a quiet phone', () => {
  it('ties a token to its phone, and clears an earlier "gone" when it registers', async () => {
    await registerDevice(H, 'mia', 'tok', 'install-1');
    expect(prisma.pushDevice.upsert.mock.calls[0][0].create.installId).toBe('install-1');
    expect(prisma.phoneStatus.updateMany).toHaveBeenCalledWith({
      where: { installId: 'install-1', userId: 'mia' },
      data: { pushGoneAt: null },
    });
  });

  it('marks the phone when Firebase says its app is gone', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([{ token: 'tok', installId: 'install-1' }]);
    fcm.sendData.mockResolvedValueOnce('invalid_token');
    expect(await pingInstall(H, 'mia', 'install-1')).toBe('gone');
    expect(fcm.sendData.mock.calls[0]).toEqual(['tok', expect.objectContaining({ type: 'ping' }), 600, 'normal']);
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({ where: { token: { in: ['tok'] } } });
    expect(prisma.phoneStatus.updateMany.mock.calls[0][0]).toMatchObject({
      where: { installId: { in: ['install-1'] } },
      data: { pushGoneAt: expect.any(Date) },
    });
  });

  it('says so when a ping went, or when there is nothing to ping with', async () => {
    prisma.pushDevice.findMany.mockResolvedValue([{ token: 'tok', installId: 'install-1' }]);
    expect(await pingInstall(H, 'mia', 'install-1')).toBe('sent');
    expect(prisma.phoneStatus.updateMany).not.toHaveBeenCalled();
    prisma.pushDevice.findMany.mockResolvedValue([]);
    expect(await pingInstall(H, 'mia', 'install-1')).toBe('none');
    fcm.isPushConfigured.mockReturnValue(false);
    expect(await pingInstall(H, 'mia', 'install-1')).toBe('none');
  });
});

describe('stale devices', () => {
  it('marks a re-registration as fresh even when nothing else changed', async () => {
    await registerDevice(H, 'alex', 'tok');
    expect(prisma.pushDevice.upsert.mock.calls[0][0].update.updatedAt).toBeInstanceOf(Date);
  });

  it('forgets tokens not re-registered for 60 days', async () => {
    const now = new Date('2026-10-14T12:00:00Z');
    await forgetStaleDevices(now);
    expect(PUSH_DEVICE_STALE_MS).toBe(60 * 86_400_000);
    expect(prisma.pushDevice.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: new Date(now.getTime() - PUSH_DEVICE_STALE_MS) } },
    });
  });
});
