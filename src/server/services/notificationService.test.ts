import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markReadSchema } from '@/lib/validation/notification';
import { FEATURES } from '@/lib/features';

// Read state is per person and shared by all of their devices: reading a
// notification anywhere wakes that member's phones, so the phone's own
// notification for it goes too.

const prisma = {
  notification: {
    updateMany: vi.fn(async (): Promise<{ count: number }> => ({ count: 0 })),
    findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/reminderService', () => ({ MANAGED_TYPES: ['overdue'] }));
vi.mock('@/server/services/serverAdminService', () => ({
  getHouseholdFeatures: vi.fn(async () => [...FEATURES]),
}));
const push = { pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);

const { markRead } = await import('./notificationService');

const ID_A = 'c' + 'a'.repeat(24);
const ID_B = 'c' + 'b'.repeat(24);

function whereOf(call: number) {
  const args = prisma.notification.updateMany.mock.calls[call] as unknown as [{ where: { AND: unknown[] } }];
  return args[0].where.AND;
}

beforeEach(() => vi.clearAllMocks());

describe('markRead', () => {
  it('wakes only this member\'s phones when something was newly read', async () => {
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(markRead('h1', 'u1', { id: ID_A })).resolves.toEqual({ updated: 1 });
    expect(push.pushSync).toHaveBeenCalledWith('h1', { userIds: ['u1'] }, 'read');
  });

  it('sends nothing when it was already read', async () => {
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.notification.findFirst.mockResolvedValueOnce({ id: ID_A });
    await expect(markRead('h1', 'u1', { id: ID_A })).resolves.toEqual({ updated: 0 });
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('still says not found for a single id the member can\'t see', async () => {
    await expect(markRead('h1', 'u1', { id: ID_A })).rejects.toThrow('Notification not found.');
  });

  it('marks a phone notification\'s list in one go, and tolerates ones already read', async () => {
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 1 });
    await expect(markRead('h1', 'u1', { ids: [ID_A, ID_B] })).resolves.toEqual({ updated: 1 });
    expect(whereOf(0)).toContainEqual({ id: { in: [ID_A, ID_B] } });
    expect(push.pushSync).toHaveBeenCalledTimes(1);

    await expect(markRead('h1', 'u1', { ids: [ID_A] })).resolves.toEqual({ updated: 0 });
    expect(prisma.notification.findFirst).not.toHaveBeenCalled();
  });

  it('mark all read is one update and one wake-up', async () => {
    prisma.notification.updateMany.mockResolvedValueOnce({ count: 5 });
    await markRead('h1', 'u1', { all: true });
    expect(whereOf(0)).toHaveLength(2);
    expect(push.pushSync).toHaveBeenCalledTimes(1);
  });
});

describe('markReadSchema', () => {
  it('takes exactly one of id, ids or all', () => {
    expect(markReadSchema.safeParse({ id: ID_A }).success).toBe(true);
    expect(markReadSchema.safeParse({ ids: [ID_A, ID_B] }).success).toBe(true);
    expect(markReadSchema.safeParse({ all: true }).success).toBe(true);
    expect(markReadSchema.safeParse({}).success).toBe(false);
    expect(markReadSchema.safeParse({ id: ID_A, all: true }).success).toBe(false);
    expect(markReadSchema.safeParse({ id: ID_A, ids: [ID_B] }).success).toBe(false);
    expect(markReadSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
