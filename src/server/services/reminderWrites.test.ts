import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// generateReminders runs inside reads (GET /api/notifications, the bell
// page), so a write conflict with another transaction writing notifications
// at the same moment (a Take back putting a "your turn" row back) is tried
// once more and then left to the next run: the read never fails because of it.

const tx = {
  notification: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
};
const prisma = {
  task: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  notification: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  user: { findMany: vi.fn(async (): Promise<unknown[]> => [{ id: 'mum', email: 'mum@example.com' }]) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));
vi.mock('@/server/services/permissionService', () => ({ membersWithAccess: vi.fn(async () => []) }));
vi.mock('@/server/services/serverAdminService', () => ({ getHouseholdFeatures: vi.fn(async () => ['tasks']) }));
vi.mock('@/server/services/pointsService', () => ({
  getPointsSettings: vi.fn(async () => ({ timezone: 'UTC', weekStartsOn: 0, minutesPerPoint: 10 })),
}));
vi.mock('@/server/services/calendarService', () => ({ listOccurrences: vi.fn(async () => []) }));

// The real isWriteConflict (taskService) decides what counts as a lost race.
const { generateReminders, refreshRemindersForRead, READ_REFRESH_MS } = await import('./reminderService');

const H = 'household1';
const conflict = () =>
  new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock.', {
    code: 'P2034',
    clientVersion: 'test',
  });
const send = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  // One overdue task, so there is a new reminder to write, push and email.
  prisma.task.findMany.mockResolvedValue([
    {
      id: 't1',
      title: 'Dishes',
      dueDate: new Date(Date.now() - 2 * 86_400_000),
      status: 'pending',
      assigneeId: 'mum',
      createdById: 'mum',
    },
  ]);
  prisma.$transaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
});

describe('generateReminders and a write conflict', () => {
  it('writes as before when nothing races it', async () => {
    await generateReminders(H, send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.notification.upsert).toHaveBeenCalledTimes(1);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum'] }, 'reminder');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a lost race is tried once more, re-reading which rows are new, and then goes on as usual', async () => {
    prisma.$transaction.mockRejectedValueOnce(conflict());
    await expect(generateReminders(H, send)).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(2);
    expect(pushSync).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a second lost race is skipped quietly: no error, no push, no email', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    prisma.$transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    await expect(generateReminders(H, send)).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(pushSync).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('any other failure still fails, and is not tried again', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    await expect(generateReminders(H, send)).rejects.toThrow('database down');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('who a reminder is emailed to', () => {
  it('skips members with a stand-in address: they see it in the bell and on the phone only', async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 'mum', email: 'mum@example.com' },
      { id: 'kid', email: 'kid@household.local' },
    ]);
    prisma.task.findMany.mockResolvedValueOnce([
      { id: 't1', title: 'Dishes', dueDate: new Date(Date.now() - 2 * 86_400_000), status: 'pending', assigneeId: 'kid', createdById: 'mum' },
    ]);
    await generateReminders(H, send);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['kid', 'mum'] }, 'reminder');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'mum@example.com' }));
  });
});

describe('overlapping runs', () => {
  // Holds the next transaction open until released, to line runs up.
  function holdNextTransaction() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    prisma.$transaction.mockImplementationOnce(async (fn: (t: typeof tx) => Promise<unknown>) => {
      await gate;
      return fn(tx);
    });
    return release;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('never overlap for one household: the second starts once the first is done, and still runs', async () => {
    const release = holdNextTransaction();
    const first = generateReminders('overlap1', send);
    const second = generateReminders('overlap1', send);
    await flush();
    // The second hasn't read which rows exist yet: that waits for the first.
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a read shares the run already going instead of starting its own', async () => {
    const release = holdNextTransaction();
    const sweep = generateReminders('overlap2', send);
    const bellA = refreshRemindersForRead('overlap2', send);
    const bellB = refreshRemindersForRead('overlap2', send);
    release();
    await Promise.all([sweep, bellA, bellB]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a read skips the rebuild within a minute of the last run; the sweep never does', async () => {
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_800_000_000_000;
    now.mockReturnValue(t0);
    await refreshRemindersForRead('fresh1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    now.mockReturnValue(t0 + READ_REFRESH_MS - 1);
    await refreshRemindersForRead('fresh1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // The 15-minute sweep always runs.
    await generateReminders('fresh1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    now.mockReturnValue(t0 + 2 * READ_REFRESH_MS);
    await refreshRemindersForRead('fresh1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  it('a failed run does not count: the next read tries again', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('database down'));
    await expect(refreshRemindersForRead('failed1', send)).rejects.toThrow('database down');
    await refreshRemindersForRead('failed1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a change in the household makes the next read rebuild at once', async () => {
    const { markRemindersStale } = await import('./reminderRuns');
    await refreshRemindersForRead('changed1', send);
    await refreshRemindersForRead('changed1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // A bill marked paid, say (logActivity marks the household stale).
    markRemindersStale('changed1');
    await refreshRemindersForRead('changed1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // Another household is not affected.
    await refreshRemindersForRead('other1', send);
    await refreshRemindersForRead('other1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('a read after a change does not share a run asked for before it', async () => {
    const { markRemindersStale } = await import('./reminderRuns');
    const release = holdNextTransaction();
    const before = refreshRemindersForRead('during1', send);
    // The change lands while that run is still going.
    markRemindersStale('during1');
    const after = refreshRemindersForRead('during1', send);
    expect(after).not.toBe(before);
    release();
    await Promise.all([before, after]);
    // The second read queued its own run behind the first.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('a run that starts right after a change does not count as fresh', async () => {
    const { markRemindersStale, STALE_GRACE_MS } = await import('./reminderRuns');
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_900_000_000_000;
    now.mockReturnValue(t0);
    // The change marks stale inside its own transaction...
    markRemindersStale('gap1');
    // ...and a read lands before that transaction commits.
    now.mockReturnValue(t0 + 100);
    await refreshRemindersForRead('gap1', send);
    // The next read rebuilds, since the first may have seen the old state.
    now.mockReturnValue(t0 + 200);
    await refreshRemindersForRead('gap1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // Once past the grace time, a run counts as fresh again.
    now.mockReturnValue(t0 + STALE_GRACE_MS + 1_000);
    await refreshRemindersForRead('gap1', send);
    now.mockReturnValue(t0 + STALE_GRACE_MS + 2_000);
    await refreshRemindersForRead('gap1', send);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });
});
