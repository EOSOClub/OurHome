import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findFirst: vi.fn(), findUnique: vi.fn() },
  household: {
    findUnique: vi.fn(
      async (): Promise<{ liveCheckMaxMinutes: number | null; liveCheckMinIntervalSec: number | null }> => ({
        liveCheckMaxMinutes: null,
        liveCheckMinIntervalSec: null,
      }),
    ),
  },
  memberLocation: { updateMany: vi.fn() },
  locationCheck: {
    findFirst: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { canPush: vi.fn(() => true), pushToMember: vi.fn(async () => 1) };
vi.mock('@/server/services/pushService', () => push);

const { getLiveCheck, reportLiveCheckFix, startLiveCheck, stopLiveCheck } = await import('./liveCheckService');

const now = new Date(Date.UTC(2026, 9, 12, 18, 0));
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);
const adult = { id: 'adult', role: 'adult' };
const sam = { id: 'sam', name: 'Sam', locationSharing: 'on', liveChecks: true };
const names = { requester: { name: 'Alex' }, target: { name: 'Sam' } };
const checkId = 'ccheck0000000000000000001';

function check(extra: Record<string, unknown> = {}) {
  return {
    id: checkId,
    householdId: 'h1',
    requesterId: 'adult',
    targetId: 'sam',
    intervalSec: 30,
    startedAt: secondsAgo(60),
    endsAt: new Date(now.getTime() + 4 * 60_000),
    endedAt: null,
    endedById: null,
    lat: null,
    lng: null,
    accuracyM: null,
    fixAt: null,
    answeredAt: null,
    ...names,
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  push.canPush.mockReturnValue(true);
  push.pushToMember.mockResolvedValue(1);
  prisma.locationCheck.findMany.mockResolvedValue([]);
  prisma.locationCheck.findFirst.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(sam);
  prisma.user.findUnique.mockResolvedValue(sam);
});

describe('startLiveCheck', () => {
  const input = { targetId: 'sam', minutes: 5, intervalSec: 30 };

  it('starts a check and wakes their phone', async () => {
    prisma.locationCheck.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...check(),
      ...args.data,
    }));
    const started = await startLiveCheck('h1', adult, input, now);
    expect(started).toMatchObject({ state: 'waiting', intervalSec: 30, targetName: 'Sam', fix: null });
    expect(new Date(started.endsAt).getTime() - now.getTime()).toBe(5 * 60_000);
    expect(push.pushToMember).toHaveBeenCalledWith('h1', 'sam', { type: 'live_check', checkId });
  });

  it('keeps the request inside the household limits', async () => {
    prisma.household.findUnique.mockResolvedValueOnce({ liveCheckMaxMinutes: 10, liveCheckMinIntervalSec: 60 });
    prisma.locationCheck.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...check(),
      ...args.data,
    }));
    const started = await startLiveCheck('h1', adult, { targetId: 'sam', minutes: 120, intervalSec: 15 }, now);
    expect(started.intervalSec).toBe(60);
    expect(new Date(started.endsAt).getTime() - now.getTime()).toBe(10 * 60_000);
  });

  it('needs push set up on the server', async () => {
    push.canPush.mockReturnValue(false);
    await expect(startLiveCheck('h1', adult, input, now)).rejects.toThrow(/Firebase/);
  });

  it('is for adults, on members who allow it', async () => {
    await expect(startLiveCheck('h1', { id: 'kid', role: 'teen' }, input, now)).rejects.toThrow(/Only adults/);
    prisma.user.findFirst.mockResolvedValue({ ...sam, liveChecks: false });
    await expect(startLiveCheck('h1', adult, input, now)).rejects.toThrow(/doesn’t allow/);
    prisma.user.findFirst.mockResolvedValue({ ...sam, locationSharing: 'off' });
    await expect(startLiveCheck('h1', adult, input, now)).rejects.toThrow(/doesn’t allow/);
    expect(prisma.locationCheck.create).not.toHaveBeenCalled();
  });

  it('refuses while someone else is checking, and returns your own running check', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check({ requesterId: 'other', requester: { name: 'Kim' } }));
    await expect(startLiveCheck('h1', adult, input, now)).rejects.toThrow(/Kim is already checking on Sam/);
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    expect((await startLiveCheck('h1', adult, input, now)).id).toBe(checkId);
    expect(prisma.locationCheck.create).not.toHaveBeenCalled();
  });

  it('closes the check, but keeps it in their log, when no phone was reached', async () => {
    prisma.locationCheck.create.mockResolvedValue(check({ startedAt: now }));
    push.pushToMember.mockResolvedValue(0);
    await expect(startLiveCheck('h1', adult, input, now)).rejects.toThrow(/Couldn’t reach Sam’s phone/);
    expect(prisma.locationCheck.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endedAt: now, endedById: 'adult' }) }),
    );
  });
});

describe('reportLiveCheckFix', () => {
  const fix = { id: checkId, lat: 45.1, lng: -93.2, accuracyM: 12, at: secondsAgo(2) };

  it('keeps only the latest fix and marks the phone as answering', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    prisma.locationCheck.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...check(),
      ...args.data,
    }));
    const result = await reportLiveCheckFix('h1', 'sam', fix, now);
    expect(result.state).toBe('live');
    expect(result.fix).toMatchObject({ lat: 45.1, lng: -93.2, accuracyM: 12 });
    expect(prisma.locationCheck.update.mock.calls[0][0].data).toMatchObject({ answeredAt: now, fixAt: fix.at });
  });

  it('ignores a fix older than the one stored', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check({ fixAt: secondsAgo(1), lat: 1, lng: 2 }));
    await reportLiveCheckFix('h1', 'sam', fix, now);
    expect(prisma.locationCheck.update).not.toHaveBeenCalled();
  });

  it('tells the phone to stop once the check is over', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check({ endsAt: secondsAgo(1) }));
    await expect(reportLiveCheckFix('h1', 'sam', fix, now)).rejects.toThrow(/ended/);
  });

  it('ends the check when they have turned live checks off', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    prisma.user.findUnique.mockResolvedValue({ ...sam, liveChecks: false });
    await expect(reportLiveCheckFix('h1', 'sam', fix, now)).rejects.toThrow(/off for you/);
    expect(prisma.locationCheck.update.mock.calls[0][0].data).toMatchObject({ endedById: 'sam', lat: null });
  });
});

describe('closing a check', () => {
  it('leaves the last fix as their last known point, only when away', async () => {
    const fixAt = secondsAgo(10);
    prisma.locationCheck.findFirst.mockResolvedValue(check({ fixAt, lat: 45.1, lng: -93.2, accuracyM: 12 }));
    await stopLiveCheck('h1', 'adult', checkId, now);
    const moved = prisma.memberLocation.updateMany.mock.calls[0][0];
    expect(moved.where).toMatchObject({ userId: 'sam', state: 'away' });
    expect(moved.data).toEqual({ lat: 45.1, lng: -93.2, accuracyM: 12, pointAt: fixAt });
    // The check itself keeps no position afterwards.
    expect(prisma.locationCheck.update.mock.calls[0][0].data).toMatchObject({ lat: null, lng: null, fixAt: null });
  });
});

describe('stopLiveCheck', () => {
  it('lets the person checking stop it, and takes the phone notification down', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    await stopLiveCheck('h1', 'adult', checkId, now);
    expect(prisma.locationCheck.update.mock.calls[0][0].data).toMatchObject({ endedAt: now, endedById: 'adult' });
    expect(push.pushToMember).toHaveBeenCalledWith('h1', 'sam', { type: 'live_check_stop', checkId });
  });

  it('lets the person checked stop it, unless their sharing is required', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    await stopLiveCheck('h1', 'sam', checkId, now);
    expect(prisma.locationCheck.update.mock.calls[0][0].data).toMatchObject({ endedById: 'sam' });
    expect(push.pushToMember).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    prisma.user.findUnique.mockResolvedValue({ locationSharing: 'required' });
    await expect(stopLiveCheck('h1', 'sam', checkId, now)).rejects.toThrow(/can’t be stopped/);
  });
});

describe('getLiveCheck', () => {
  it('is only for the two people in it', async () => {
    prisma.locationCheck.findFirst.mockResolvedValue(check());
    await expect(getLiveCheck('h1', 'stranger', checkId, now)).rejects.toThrow(/not found/);
    expect((await getLiveCheck('h1', 'sam', checkId, now)).state).toBe('waiting');
  });
});
