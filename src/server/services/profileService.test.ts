import { beforeEach, describe, expect, it, vi } from 'vitest';

const ME = 'cm' + 'a'.repeat(23);
const row = {
  id: ME,
  name: 'Sam',
  email: 'sam@household.local',
  displayUsername: 'sam',
  username: 'sam',
  role: 'child',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  bio: null,
  avatarEmoji: null,
  profileColor: null,
  birthday: null,
  household: { name: 'Home' },
};
const prisma = {
  user: {
    findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => row),
    findFirst: vi.fn(async (): Promise<{ id: string; username: string | null } | null> => null),
    update: vi.fn(),
  },
  taskCompletion: { count: vi.fn(async () => 0) },
  task: { count: vi.fn(async () => 0) },
  purchase: { count: vi.fn(async () => 0) },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/auth/auth', () => ({ auth: { $context: Promise.resolve({}) } }));

const { updateProfile } = await import('./profileService');

describe('updateProfile: renaming yourself without a real email', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves the stand-in email to the new username, so the old one is free again', async () => {
    await updateProfile(ME, { username: 'Samuel', email: 'sam@household.local' } as never);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ username: 'samuel', email: 'samuel@household.local' }) }),
    );
  });

  it('keeps a real email that was typed', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ ...row, email: 'sam@example.com' });
    await updateProfile(ME, { username: 'samuel', email: 'sam@example.com' } as never);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'sam@example.com' }) }),
    );
  });

  it('says the username is taken when the moved stand-in is already used', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'other', username: 'someone' });
    await expect(updateProfile(ME, { username: 'samuel' } as never)).rejects.toMatchObject({
      message: 'That username is already taken. Try another.',
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
