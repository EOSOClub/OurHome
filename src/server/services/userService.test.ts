import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  account: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/auth/auth', () => ({
  auth: { $context: Promise.resolve({ password: { hash: async (p: string) => `hashed:${p}` } }) },
}));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const dropBrokenSupervision = vi.fn();
const newMemberSupervisors = vi.fn(async (): Promise<{ id: string; name: string; role: string }[]> => []);
const linkNewSupervisors = vi.fn();
vi.mock('@/server/services/supervisionService', () => ({
  dropBrokenSupervision,
  newMemberSupervisors,
  linkNewSupervisors,
}));
const refreshPhoneAlerts = vi.fn();
vi.mock('@/server/services/phoneStatusService', () => ({ refreshPhoneAlerts }));

const { createMember, setMemberRole, transferHeadship, updateMember } = await import('./userService');

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

describe('createMember with supervisors', () => {
  const kidInput = { name: 'Mia', username: 'mia', role: 'child' as const, password: 'password1' };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue(null); // assertUnique: no clash
  });

  it('checks who supervises them before making anything', async () => {
    newMemberSupervisors.mockRejectedValueOnce(new Error('Only the Head of House can choose who supervises whom.'));
    await expect(
      createMember(HOUSEHOLD, { id: 'gran', role: 'manager' }, { ...kidInput, supervisorIds: ['gran'] }),
    ).rejects.toThrow(/Only the Head of House/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('links the supervisors with the new account and says so in Activity', async () => {
    const alex = { id: 'alex', name: 'Alex', role: 'adult' };
    newMemberSupervisors.mockResolvedValueOnce([{ id: head.id, name: 'Sam', role: 'head' }, alex]);
    prisma.user.create.mockResolvedValueOnce(row({ id: 'newkid', name: 'Mia', role: 'child', mustChangePassword: true }));
    const made = await createMember(HOUSEHOLD, head, { ...kidInput, supervisorIds: [head.id, 'alex'] });
    expect(made.id).toBe('newkid');
    expect(newMemberSupervisors).toHaveBeenCalledWith(HOUSEHOLD, head, 'child', [head.id, 'alex']);
    expect(linkNewSupervisors).toHaveBeenCalledWith(prisma, HOUSEHOLD, head.id, 'newkid', [
      { id: head.id, name: 'Sam', role: 'head' },
      alex,
    ]);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'added Child “Mia”, supervised by Sam, Alex' }),
      prisma,
    );
  });

  it('logs as before when nobody was ticked', async () => {
    prisma.user.create.mockResolvedValueOnce(row({ id: 'newkid', name: 'Mia', role: 'child' }));
    await createMember(HOUSEHOLD, head, kidInput);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'added Child “Mia”' }), prisma);
  });
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
