import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/auth/auth', () => ({ auth: {} }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
const dropBrokenSupervision = vi.fn();
vi.mock('@/server/services/supervisionService', () => ({ dropBrokenSupervision }));
const refreshPhoneAlerts = vi.fn();
vi.mock('@/server/services/phoneStatusService', () => ({ refreshPhoneAlerts }));

const { setMemberRole, transferHeadship, updateMember } = await import('./userService');

const HOUSEHOLD = 'household1';
const head = { id: 'cmhead00000000000000000001', role: 'head' };
const row = (over: Record<string, unknown>) => ({
  id: head.id,
  name: 'Sam',
  email: 'sam@example.com',
  username: 'sam',
  displayUsername: 'Sam',
  role: 'head',
  mustChangePassword: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('updateMember', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses a new email for yourself: that needs your password, on the profile', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({}));
    await expect(
      updateMember(HOUSEHOLD, head, { id: head.id, email: 'new@example.com' }),
    ).rejects.toThrow(/from your profile/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('lets you resend your own unchanged email with other edits', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce(row({})) // loadMember
      .mockResolvedValueOnce(null); // assertUnique: no clash
    prisma.user.update.mockResolvedValueOnce(row({ name: 'Samantha' }));
    const saved = await updateMember(HOUSEHOLD, head, {
      id: head.id,
      name: 'Samantha',
      email: 'SAM@example.com',
    });
    expect(saved.name).toBe('Samantha');
  });

  it("still lets the head change someone else's email", async () => {
    const other = 'cmother0000000000000000001';
    prisma.user.findFirst
      .mockResolvedValueOnce(row({ id: other, role: 'adult' }))
      .mockResolvedValueOnce(null);
    prisma.user.update.mockResolvedValueOnce(row({ id: other, role: 'adult', email: 'kid@example.com' }));
    const saved = await updateMember(HOUSEHOLD, head, { id: other, email: 'kid@example.com' });
    expect(saved.email).toBe('kid@example.com');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'kid@example.com' }) }),
    );
  });
});

describe('role changes and supervision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checks the supervision list when a role changes', async () => {
    const kid = 'cmkid000000000000000000001';
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: kid, role: 'teen' }));
    prisma.user.update.mockResolvedValueOnce(row({ id: kid, role: 'adult' }));
    await setMemberRole(HOUSEHOLD, head, { id: kid, role: 'adult' });
    expect(dropBrokenSupervision).toHaveBeenCalledWith(prisma, kid, 'adult');
    // Who gets phone alerts may have changed with it.
    expect(refreshPhoneAlerts).toHaveBeenCalledWith(HOUSEHOLD);
  });

  it('checks it for a new Head of House too', async () => {
    const kid = 'cmkid000000000000000000001';
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: kid, role: 'teen' }));
    prisma.user.update.mockResolvedValueOnce(row({ id: kid, role: 'head' }));
    await transferHeadship(HOUSEHOLD, head, kid);
    expect(dropBrokenSupervision).toHaveBeenCalledWith(prisma, kid, 'head');
    expect(refreshPhoneAlerts).toHaveBeenCalledWith(HOUSEHOLD);
  });
});
