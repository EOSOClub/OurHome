import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: { findFirst: vi.fn(async (): Promise<unknown> => ({ name: 'Riley' })) },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  notification: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    createMany: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const push = { pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);

const { reportPinEvents } = await import('./parentPinService');
const { pinEventText } = await import('@/lib/parentPin');

const H = 'h1';
const now = new Date('2026-10-26T18:30:00Z');
const at = (iso: string) => new Date(iso).getTime();
const link = (supervisorId: string, role = 'adult') => ({
  supervisorId,
  supervisor: { role },
  supervised: { role: 'child' },
});
const rows = () => prisma.notification.createMany.mock.calls[0][0].data as Record<string, unknown>[];

describe('parent PIN alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.supervision.findMany.mockResolvedValue([link('alex'), link('sam'), link('guesty', 'guest')]);
  });

  it('tells each supervisor about each opened screen and unlock once, dated when it happened', async () => {
    // Sam already heard about the opened screen (a check-in that sent it before).
    prisma.notification.findMany.mockResolvedValueOnce([{ dedupeKey: 'pin:opened:riley:event-0001:sam' }]);
    const result = await reportPinEvents(
      H,
      'riley',
      [
        { id: 'event-0001', kind: 'opened', atMs: at('2026-10-26T18:00:00Z'), screen: 'private_dns' },
        { id: 'event-0002', kind: 'unlocked', atMs: at('2026-10-26T18:10:00Z') },
      ],
      now,
    );
    expect(result).toEqual({ told: 3 });
    expect(rows().map((r) => r.dedupeKey)).toEqual([
      'pin:opened:riley:event-0001:alex',
      'pin:unlocked:riley:event-0002:alex',
      'pin:unlocked:riley:event-0002:sam',
    ]);
    expect(rows()[0]).toMatchObject({
      userId: 'alex',
      type: 'parent_pin',
      title: "Your PIN was used on Riley's phone",
      subjectType: 'phone',
      subjectId: 'riley',
      readAt: null,
      createdAt: new Date('2026-10-26T18:00:00Z'),
    });
    expect(rows()[0].body).toContain("Private DNS, the web filter's setting");
    expect(rows()[1].title).toBe("Your PIN unlocked OurHome on Riley's phone");
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['alex', 'sam'] }, 'reminder');
  });

  it('makes wrong-PIN waits one alert an hour per supervisor', async () => {
    const wrong = (id: string, iso: string) => ({ id, kind: 'wrong_pin', atMs: at(iso) });
    await reportPinEvents(
      H,
      'riley',
      [
        wrong('event-0003', '2026-10-26T17:05:00Z'),
        wrong('event-0004', '2026-10-26T17:40:00Z'),
        wrong('event-0005', '2026-10-26T18:01:00Z'),
      ],
      now,
    );
    expect(rows().map((r) => r.dedupeKey)).toEqual([
      'pin:wrong_pin:riley:2026-10-26T17:alex',
      'pin:wrong_pin:riley:2026-10-26T17:sam',
      'pin:wrong_pin:riley:2026-10-26T18:alex',
      'pin:wrong_pin:riley:2026-10-26T18:sam',
    ]);
    expect(rows()[0]).toMatchObject({ title: "Wrong parent PIN on Riley's phone", createdAt: new Date('2026-10-26T17:05:00Z') });
  });

  it('never dates an alert later than now, from a phone whose clock is fast', async () => {
    await reportPinEvents(H, 'riley', [{ id: 'event-0006', kind: 'unlocked', atMs: at('2026-10-26T20:00:00Z') }], now);
    expect(rows()[0].createdAt).toEqual(now);
  });

  it('drops kinds it does not know and events from over a week ago, and tells nobody without supervisors', async () => {
    expect(
      await reportPinEvents(
        H,
        'riley',
        [
          { id: 'event-0007', kind: 'something_newer', atMs: at('2026-10-26T18:00:00Z') },
          { id: 'event-0008', kind: 'unlocked', atMs: at('2026-10-18T18:00:00Z') },
        ],
        now,
      ),
    ).toEqual({ told: 0 });
    prisma.supervision.findMany.mockResolvedValueOnce([link('guesty', 'guest')]);
    expect(
      await reportPinEvents(H, 'riley', [{ id: 'event-0009', kind: 'unlocked', atMs: at('2026-10-26T18:00:00Z') }], now),
    ).toEqual({ told: 0 });
    prisma.notification.findMany.mockResolvedValueOnce([
      { dedupeKey: 'pin:unlocked:riley:event-0010:alex' },
      { dedupeKey: 'pin:unlocked:riley:event-0010:sam' },
    ]);
    expect(
      await reportPinEvents(H, 'riley', [{ id: 'event-0010', kind: 'unlocked', atMs: at('2026-10-26T18:00:00Z') }], now),
    ).toEqual({ told: 0 });
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('names each protected screen, and any other as a protected screen', () => {
    expect(pinEventText('opened', 'Riley', 'app_info').body).toContain("OurHome's App info, where Force stop is");
    expect(pinEventText('opened', 'Riley', 'device_admin').body).toContain("OurHome's Device admin page");
    expect(pinEventText('opened', 'Riley', 'accessibility').body).toContain('Keep Our Home running in Accessibility');
    expect(pinEventText('opened', 'Riley', 'newer_screen').body).toContain('to open a protected screen.');
    expect(pinEventText('opened', 'Riley').body).toContain('to open a protected screen.');
  });
});
