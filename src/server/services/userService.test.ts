import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  supervision: {
    findMany: vi.fn(async (): Promise<{ supervisedId: string }[]> => []),
    deleteMany: vi.fn(),
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
const releaseIfUnsupervised = vi.fn();
vi.mock('@/server/services/supervisionService', () => ({
  dropBrokenSupervision,
  newMemberSupervisors,
  linkNewSupervisors,
  releaseIfUnsupervised,
}));
const refreshPhoneAlerts = vi.fn();
vi.mock('@/server/services/phoneStatusService', () => ({ refreshPhoneAlerts }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));
// Task checks nobody can decide any more (Task Photo Proof), settled after a change.
const settleOrphanedSubmissions = vi.fn(async () => 0);
vi.mock('@/server/services/taskSubmissionService', () => ({ settleOrphanedSubmissions }));

const { createMember, removeMember, setMemberRole, transferHeadship, updateMember } = await import('./userService');

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

  it('names the field that clashes, so the form can mark it', async () => {
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'other', username: 'mia' });
    await expect(createMember(HOUSEHOLD, head, kidInput)).rejects.toMatchObject({
      message: 'That username is already taken. Try another.',
      field: 'username',
    });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'other', username: 'someone' });
    await expect(createMember(HOUSEHOLD, head, { ...kidInput, email: 'taken@example.com' })).rejects.toMatchObject({
      message: 'That email is already used by another account.',
      field: 'email',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('logs as before when nobody was ticked', async () => {
    prisma.user.create.mockResolvedValueOnce(row({ id: 'newkid', name: 'Mia', role: 'child' }));
    await createMember(HOUSEHOLD, head, kidInput);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'added Child “Mia”' }), prisma);
  });
});

describe('createMember with phone choices (Set up a child)', () => {
  const kidInput = { name: 'Mia', username: 'mia', role: 'child' as const, password: 'password1' };
  const allOn = { keepRunning: true, preventUninstall: true, batteryUnrestricted: true };
  const alex = { id: 'alex', name: 'Alex', role: 'adult' };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue(null); // assertUnique: no clash
  });

  it('refuses them unless the adult adding them supervises them, before making anything', async () => {
    newMemberSupervisors.mockResolvedValueOnce([alex]);
    await expect(
      createMember(HOUSEHOLD, head, {
        ...kidInput,
        supervisorIds: ['alex'],
        setup: { locationRequired: true, shareAppUsage: false, rules: allOn },
      }),
    ).rejects.toMatchObject({ field: 'setup', message: expect.stringMatching(/Only an adult who supervises them/) });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('stores only what differs from the defaults, and says so in Activity', async () => {
    newMemberSupervisors.mockResolvedValueOnce([{ id: head.id, name: 'Sam', role: 'head' }]);
    prisma.user.create.mockResolvedValueOnce(row({ id: 'newkid', name: 'Mia', role: 'child', mustChangePassword: true }));
    await createMember(HOUSEHOLD, head, {
      ...kidInput,
      supervisorIds: [head.id],
      setup: {
        locationRequired: true,
        shareAppUsage: true,
        rules: { ...allOn, preventUninstall: false },
      },
    });
    const { data } = prisma.user.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ locationSharing: 'required', shareAppUsage: true, requirePreventUninstall: false });
    // Left on is the default (null), so it isn't written.
    expect(data).not.toHaveProperty('requireKeepRunning');
    expect(data).not.toHaveProperty('requireBatteryUnrestricted');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'added Child “Mia”, supervised by Sam; location sharing required, app usage shared, Prevent uninstall not required',
      }),
      prisma,
    );
  });

  it('writes nothing extra when every choice is the default', async () => {
    newMemberSupervisors.mockResolvedValueOnce([{ id: head.id, name: 'Sam', role: 'head' }]);
    prisma.user.create.mockResolvedValueOnce(row({ id: 'newkid', name: 'Mia', role: 'child' }));
    await createMember(HOUSEHOLD, head, {
      ...kidInput,
      supervisorIds: [head.id],
      setup: { locationRequired: false, shareAppUsage: false, rules: allOn },
    });
    const { data } = prisma.user.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('locationSharing');
    expect(data).not.toHaveProperty('shareAppUsage');
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'added Child “Mia”, supervised by Sam' }),
      prisma,
    );
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

describe('removeMember and supervision', () => {
  const alex = 'cmalex00000000000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the children they supervised their controls back once nobody is left to supervise them', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: alex, name: 'Alex', role: 'adult' }));
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisedId: 'sam' }, { supervisedId: 'jo' }]);
    await removeMember(HOUSEHOLD, head, alex);
    expect(prisma.supervision.findMany).toHaveBeenCalledWith({ where: { supervisorId: alex }, select: { supervisedId: true } });
    expect(prisma.supervision.deleteMany).toHaveBeenCalledWith({ where: { supervisorId: alex } });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: alex } });
    // Checked in the same transaction, after their links and their account are gone.
    expect(releaseIfUnsupervised).toHaveBeenCalledWith(prisma, ['sam', 'jo']);
    expect(prisma.supervision.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      releaseIfUnsupervised.mock.invocationCallOrder[0],
    );
    expect(prisma.user.delete.mock.invocationCallOrder[0]).toBeLessThan(releaseIfUnsupervised.mock.invocationCallOrder[0]);
    expect(refreshPhoneAlerts).toHaveBeenCalledWith(HOUSEHOLD);
    // Their phones learn at once what is required of them now.
    expect(pushSync).toHaveBeenCalledWith(HOUSEHOLD, { userIds: ['sam', 'jo'] }, 'supervision');
    // Checks nobody is left to decide are settled, after it all is saved.
    expect(settleOrphanedSubmissions).toHaveBeenCalledWith(HOUSEHOLD);
    expect(settleOrphanedSubmissions.mock.invocationCallOrder[0]).toBeGreaterThan(prisma.user.delete.mock.invocationCallOrder[0]);
  });

  it('checks nobody when they supervised nobody', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: alex, name: 'Alex', role: 'adult' }));
    await removeMember(HOUSEHOLD, head, alex);
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: alex } });
    expect(prisma.supervision.deleteMany).not.toHaveBeenCalled();
    expect(releaseIfUnsupervised).not.toHaveBeenCalled();
    expect(pushSync).not.toHaveBeenCalled();
    // A removed child's own checks are still settled (withdrawn).
    expect(settleOrphanedSubmissions).toHaveBeenCalledWith(HOUSEHOLD);
  });
});

describe('task checks after member changes', () => {
  const kid = 'cmkid000000000000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settles them after a role change is saved', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: kid, role: 'teen' }));
    prisma.user.update.mockResolvedValueOnce(row({ id: kid, role: 'adult' }));
    await setMemberRole(HOUSEHOLD, head, { id: kid, role: 'adult' });
    expect(settleOrphanedSubmissions).toHaveBeenCalledWith(HOUSEHOLD);
    expect(settleOrphanedSubmissions.mock.invocationCallOrder[0]).toBeGreaterThan(dropBrokenSupervision.mock.invocationCallOrder[0]);
  });

  it('settles them after headship moves', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: kid, role: 'teen' }));
    prisma.user.update.mockResolvedValueOnce(row({ id: kid, role: 'head' }));
    await transferHeadship(HOUSEHOLD, head, kid);
    expect(settleOrphanedSubmissions).toHaveBeenCalledWith(HOUSEHOLD);
  });

  it('a failed settle never fails the change: the sweep tries again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    settleOrphanedSubmissions.mockRejectedValueOnce(new Error('db down'));
    prisma.user.findFirst.mockResolvedValueOnce(row({ id: kid, role: 'teen' }));
    prisma.user.update.mockResolvedValueOnce(row({ id: kid, role: 'child' }));
    await expect(setMemberRole(HOUSEHOLD, head, { id: kid, role: 'child' })).resolves.toMatchObject({ id: kid });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('never settles for a profile edit', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(row({})).mockResolvedValueOnce(null);
    prisma.user.update.mockResolvedValueOnce(row({ name: 'Samantha' }));
    await updateMember(HOUSEHOLD, head, { id: head.id, name: 'Samantha' });
    expect(settleOrphanedSubmissions).not.toHaveBeenCalled();
  });
});
