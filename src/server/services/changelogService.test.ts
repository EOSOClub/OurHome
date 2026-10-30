import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGELOG } from '@/lib/changelog';

// "What's new" is closed once per person: the website and the app read and
// write the same User.changelogSeen.

const prisma = {
  user: {
    findUnique: vi.fn(async (): Promise<unknown> => null),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { markChangelogSeen, unseenFor } = await import('./changelogService');

const NEWEST = CHANGELOG[0].id;

beforeEach(() => vi.clearAllMocks());

describe('markChangelogSeen', () => {
  it('only moves forward, so an older list closed later brings nothing back', async () => {
    await markChangelogSeen('u1', NEWEST);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'u1',
        OR: [{ changelogSeen: null }, { changelogSeen: { isSet: false } }, { changelogSeen: { lt: NEWEST } }],
      },
      data: { changelogSeen: NEWEST },
    });
  });

  it('refuses an id that is not in the list', async () => {
    await expect(markChangelogSeen('u1', '1999-01-01')).rejects.toThrow('That update note is gone.');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe('unseenFor', () => {
  it('nothing once the newest is closed', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ changelogSeen: NEWEST, createdAt: new Date('2026-01-01') });
    await expect(unseenFor('u1')).resolves.toEqual([]);
  });

  it('a member from before the newest release who never closed one sees it', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ changelogSeen: null, createdAt: new Date('2026-01-01') });
    await expect(unseenFor('u1')).resolves.toEqual(expect.arrayContaining([CHANGELOG[0]]));
  });

  it('no such member: nothing', async () => {
    await expect(unseenFor('gone')).resolves.toEqual([]);
  });
});
