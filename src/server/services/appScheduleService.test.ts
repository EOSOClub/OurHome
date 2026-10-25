import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  appSchedule: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  appIcon: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { allowedApps, isScheduledFor, phoneSchedules, scheduledAppNames, schedulesByKid } = await import(
  './appScheduleService'
);

const H = 'h1';
const MAPS = 'com.google.android.apps.maps';
const at = new Date('2026-10-12T17:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  userId: 'riley',
  name: 'Bedtime',
  days: [6, 0],
  start: 1260,
  end: 420,
  allowed: JSON.stringify([{ app: MAPS, label: 'Maps' }]),
  setById: 'alex',
  updatedAt: at,
  ...over,
});

describe('schedules', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers the phone with each schedule, its allowed apps and who saved it', async () => {
    prisma.appSchedule.findMany.mockResolvedValueOnce([row(), row({ id: 's2', setById: 'gone', allowed: 'broken' })]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'alex', name: 'Alex Morgan' }]);
    expect(await phoneSchedules(H, 'riley')).toEqual([
      { id: 's1', name: 'Bedtime', days: [0, 6], start: 1260, end: 420, allowed: [MAPS], by: 'Alex Morgan' },
      { id: 's2', name: 'Bedtime', days: [0, 6], start: 1260, end: 420, allowed: [], by: null },
    ]);
    expect(prisma.appSchedule.findMany).toHaveBeenCalledWith({
      where: { householdId: H, userId: 'riley' },
      orderBy: { start: 'asc' },
    });
  });

  it('lists each child’s schedules for their page, with icons for the allowed apps', async () => {
    prisma.appSchedule.findMany.mockResolvedValueOnce([row()]);
    prisma.user.findMany.mockResolvedValueOnce([]);
    prisma.appIcon.findMany.mockResolvedValueOnce([{ app: MAPS }]);
    const byKid = await schedulesByKid(H, ['riley', 'mia']);
    expect(byKid.get('riley')).toEqual([
      {
        id: 's1',
        name: 'Bedtime',
        days: [0, 6],
        start: 1260,
        end: 420,
        allowed: [{ app: MAPS, label: 'Maps', icon: true }],
        byName: 'Someone who has left',
        at: at.toISOString(),
      },
    ]);
    expect(byKid.has('mia')).toBe(false);
    expect((await schedulesByKid(H, [])).size).toBe(0);
  });

  it('knows which apps schedules still allow, and reads only well-formed lists', async () => {
    prisma.appSchedule.findMany.mockResolvedValueOnce([row(), row({ allowed: '[]' })]);
    expect(await scheduledAppNames(prisma as never, H)).toEqual([MAPS]);
    prisma.appSchedule.findMany.mockResolvedValueOnce([row()]);
    expect(await isScheduledFor(['riley'], MAPS)).toBe(true);
    prisma.appSchedule.findMany.mockResolvedValueOnce([row()]);
    expect(await isScheduledFor(['riley'], 'com.other')).toBe(false);
    expect(await isScheduledFor([], MAPS)).toBe(false);
    expect(allowedApps('[{"app":1}]')).toEqual([]);
    expect(allowedApps('nope')).toEqual([]);
  });
});
