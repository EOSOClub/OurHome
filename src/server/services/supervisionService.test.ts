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
const push = { canPush: vi.fn(() => true), pushToMember: vi.fn(async () => 1) };
vi.mock('@/server/services/pushService', () => push);

const { dropBrokenSupervision, getSupervision, ringOverview, ringPhone, setSupervisors } = await import(
  './supervisionService'
);

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

describe('ringing a phone', () => {
  // supervision.findMany as ringPhone asks it: the actor's links with both roles.
  const linksOf = (...kids: Person[]) => kids.map((k) => ({ supervisor: { role: 'adult' }, supervised: k }));
  const findLinks = prisma.supervision.findMany as unknown as ReturnType<typeof vi.fn>;
  let clock = 1_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    push.canPush.mockReturnValue(true);
    push.pushToMember.mockResolvedValue(1);
    clock += 3_600_000; // every test well past the last one's ring
  });

  it('lists only the kids the viewer supervises, whose roles still fit', async () => {
    findLinks.mockResolvedValueOnce([...linksOf(sam, jo), { supervisor: { role: 'adult' }, supervised: { ...alex } }]);
    expect(await ringOverview(H, 'alex')).toEqual({
      available: true,
      ringable: [{ id: 'jo', name: 'Jo' }, { id: 'sam', name: 'Sam' }],
    });
  });

  it('rings a supervised child with a short-lived push and logs it', async () => {
    findLinks.mockResolvedValueOnce(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    expect(push.pushToMember).toHaveBeenCalledWith(H, 'sam', { type: 'ring', ringerId: 'alex' }, { ttlSec: 60 });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alex', message: 'rang Sam’s phone' }));
  });

  it('refuses anyone who does not supervise them', async () => {
    findLinks.mockResolvedValueOnce(linksOf(jo));
    await expect(ringPhone(H, { id: 'gran' }, 'sam', clock)).rejects.toThrow(/Only an adult who supervises/);
    expect(push.pushToMember).not.toHaveBeenCalled();
  });

  it('refuses a second ring while the phone still rings, but not one after', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    await expect(ringPhone(H, { id: 'alex' }, 'sam', clock + 10_000)).rejects.toThrow(/already ringing/);
    await ringPhone(H, { id: 'alex' }, 'sam', clock + 31_000);
    expect(push.pushToMember).toHaveBeenCalledTimes(2);
    findLinks.mockReset();
  });

  it('says so when no phone answered, and lets them try again at once', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    push.pushToMember.mockResolvedValueOnce(0);
    await expect(ringPhone(H, { id: 'alex' }, 'sam', clock)).rejects.toThrow(/Couldn’t reach Sam’s phone/);
    expect(logActivity).not.toHaveBeenCalled();
    await ringPhone(H, { id: 'alex' }, 'sam', clock + 1000);
    findLinks.mockReset();
  });

  it('needs Firebase', async () => {
    push.canPush.mockReturnValue(false);
    await expect(ringPhone(H, { id: 'alex' }, 'sam', clock)).rejects.toThrow(/Firebase/);
  });
});
