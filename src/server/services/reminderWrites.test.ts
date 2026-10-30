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
const { generateReminders } = await import('./reminderService');

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
