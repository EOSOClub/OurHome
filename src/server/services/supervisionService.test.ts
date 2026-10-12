import { beforeEach, describe, expect, it, vi } from 'vitest';

type Person = { id: string; name: string; role: string };
type Link = { supervisorId: string; supervisedId: string };

const tx = {
  supervision: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
};
const prisma = {
  user: {
    findFirst: vi.fn(async (): Promise<Person | null> => null),
    findMany: vi.fn(async (): Promise<Person[]> => []),
  },
  supervision: {
    findMany: vi.fn(async (): Promise<Link[]> => []),
  },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));

const { dropBrokenSupervision, getSupervision, setSupervisors } = await import('./supervisionService');

const H = 'household1';
const head = { id: 'head', role: 'head' };
const pat: Person = { id: 'head', name: 'Pat', role: 'head' };
const alex: Person = { id: 'alex', name: 'Alex', role: 'adult' };
const gran: Person = { id: 'gran', name: 'Gran', role: 'manager' };
const sam: Person = { id: 'sam', name: 'Sam', role: 'child' };
const jo: Person = { id: 'jo', name: 'Jo', role: 'teen' };
const guest: Person = { id: 'guest', name: 'Guest', role: 'guest' };

describe('getSupervision', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists supervisors highest role first and kids with their supervisors', async () => {
    prisma.user.findMany.mockResolvedValueOnce([sam, alex, guest, pat, jo, gran]);
    prisma.supervision.findMany.mockResolvedValueOnce([
      { supervisorId: 'alex', supervisedId: 'sam' },
      { supervisorId: 'head', supervisedId: 'sam' },
    ]);
    const list = await getSupervision(H);
    expect(list.supervisors.map((s) => s.id)).toEqual(['head', 'gran', 'alex']);
    expect(list.supervised).toEqual([
      { id: 'jo', name: 'Jo', role: 'teen', supervisorIds: [] },
      { id: 'sam', name: 'Sam', role: 'child', supervisorIds: ['head', 'alex'] },
    ]);
  });

  it('ignores a link whose roles no longer fit', async () => {
    prisma.user.findMany.mockResolvedValueOnce([pat, { ...alex, role: 'guest' }, sam]);
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisorId: 'alex', supervisedId: 'sam' }]);
    const list = await getSupervision(H);
    expect(list.supervised[0].supervisorIds).toEqual([]);
  });
});

describe('setSupervisors', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is for the Head of House only', async () => {
    await expect(
      setSupervisors(H, { id: 'gran', role: 'manager' }, { supervisedId: 'sam', supervisorIds: ['gran'] }),
    ).rejects.toThrow(/Only the Head of House/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses someone who is not in the household', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(setSupervisors(H, head, { supervisedId: 'other', supervisorIds: [] })).rejects.toThrow(
      /not in this household/,
    );
  });

  it('only supervises children and teens', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(alex);
    await expect(setSupervisors(H, head, { supervisedId: 'alex', supervisorIds: ['head'] })).rejects.toThrow(
      /Alex can’t be supervised/,
    );
  });

  it('refuses a supervisor from another household', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(sam);
    prisma.user.findMany.mockResolvedValueOnce([alex]);
    await expect(
      setSupervisors(H, head, { supervisedId: 'sam', supervisorIds: ['alex', 'stranger'] }),
    ).rejects.toThrow(/not in this household/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a supervisor below adult', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(sam);
    prisma.user.findMany.mockResolvedValueOnce([jo]);
    await expect(setSupervisors(H, head, { supervisedId: 'sam', supervisorIds: ['jo'] })).rejects.toThrow(
      /Jo can’t supervise anyone/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('adds and removes only what changed, and logs it', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(sam);
    prisma.user.findMany.mockResolvedValueOnce([gran, pat]); // the wanted supervisors
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisorId: 'alex', supervisedId: 'sam' }, { supervisorId: 'head', supervisedId: 'sam' }]);
    await setSupervisors(H, head, { supervisedId: 'sam', supervisorIds: ['head', 'gran', 'gran'] });
    expect(tx.supervision.deleteMany).toHaveBeenCalledWith({
      where: { supervisedId: 'sam', supervisorId: { in: ['alex'] } },
    });
    expect(tx.supervision.createMany).toHaveBeenCalledWith({
      data: [{ householdId: H, supervisorId: 'gran', supervisedId: 'sam', createdById: 'head' }],
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'set who supervises Sam: Pat, Gran' }),
      tx,
    );
  });

  it('can clear everyone', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(jo);
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisorId: 'alex', supervisedId: 'jo' }]);
    await setSupervisors(H, head, { supervisedId: 'jo', supervisorIds: [] });
    expect(tx.supervision.createMany).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'removed everyone supervising Jo' }),
      tx,
    );
  });

  it('writes nothing when nothing changed', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(sam);
    prisma.user.findMany.mockResolvedValueOnce([alex]);
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisorId: 'alex', supervisedId: 'sam' }]);
    await setSupervisors(H, head, { supervisedId: 'sam', supervisorIds: ['alex'] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe('dropBrokenSupervision', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes a kid who became an adult from the list', async () => {
    await dropBrokenSupervision(tx as never, 'sam', 'adult');
    expect(tx.supervision.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.supervision.deleteMany).toHaveBeenCalledWith({ where: { supervisedId: 'sam' } });
  });

  it('removes an adult who became a teen as a supervisor', async () => {
    await dropBrokenSupervision(tx as never, 'alex', 'teen');
    expect(tx.supervision.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.supervision.deleteMany).toHaveBeenCalledWith({ where: { supervisorId: 'alex' } });
  });

  it('removes a guest from both sides', async () => {
    await dropBrokenSupervision(tx as never, 'g', 'guest');
    expect(tx.supervision.deleteMany).toHaveBeenCalledTimes(2);
  });
});
