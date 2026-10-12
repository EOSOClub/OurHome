import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findUnique: vi.fn() },
  memberLocation: { findUnique: vi.fn(), update: vi.fn() },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { reportBattery, saveBattery } = await import('./batteryService');

const now = new Date(Date.UTC(2026, 9, 12, 18, 0));
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const level = { pct: 64, charging: false };

describe('saveBattery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores a newer reading', async () => {
    prisma.memberLocation.findUnique.mockResolvedValueOnce({ householdId: 'h1', batteryAt: minutesAgo(60) });
    await saveBattery('h1', 'u1', level, minutesAgo(1), now);
    expect(prisma.memberLocation.update).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      data: { batteryPct: 64, batteryCharging: false, batteryAt: minutesAgo(1) },
    });
  });

  it('ignores a reading older than the stored one (sent late)', async () => {
    prisma.memberLocation.findUnique.mockResolvedValueOnce({ householdId: 'h1', batteryAt: minutesAgo(5) });
    await saveBattery('h1', 'u1', level, minutesAgo(30), now);
    expect(prisma.memberLocation.update).not.toHaveBeenCalled();
  });

  it('does nothing before the phone has reported where it is', async () => {
    prisma.memberLocation.findUnique.mockResolvedValueOnce(null);
    await saveBattery('h1', 'u1', level, minutesAgo(1), now);
    expect(prisma.memberLocation.update).not.toHaveBeenCalled();
  });

  it('never touches a row from another household', async () => {
    prisma.memberLocation.findUnique.mockResolvedValueOnce({ householdId: 'h2', batteryAt: null });
    await saveBattery('h1', 'u1', level, minutesAgo(1), now);
    expect(prisma.memberLocation.update).not.toHaveBeenCalled();
  });

  it('dates a reading from a fast phone clock now, not in the future', async () => {
    prisma.memberLocation.findUnique.mockResolvedValueOnce({ householdId: 'h1', batteryAt: null });
    await saveBattery('h1', 'u1', level, new Date(now.getTime() + 3_600_000), now);
    expect(prisma.memberLocation.update.mock.calls[0][0].data.batteryAt).toEqual(now);
  });
});

describe('reportBattery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is refused while the member does not share their location', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'off' });
    await expect(reportBattery('h1', 'u1', { ...level, at: minutesAgo(1) }, now)).rejects.toThrow(/sharing is off/);
    expect(prisma.memberLocation.findUnique).not.toHaveBeenCalled();
  });

  it('stores it while they share', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'on' });
    prisma.memberLocation.findUnique.mockResolvedValueOnce({ householdId: 'h1', batteryAt: null });
    await reportBattery('h1', 'u1', { pct: 15, charging: true, at: minutesAgo(1) }, now);
    expect(prisma.memberLocation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ batteryPct: 15, batteryCharging: true }) }),
    );
  });
});
