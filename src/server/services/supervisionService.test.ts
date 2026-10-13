import { beforeEach, describe, expect, it, vi } from 'vitest';

type Person = { id: string; name: string; role: string };
type Link = { supervisorId: string; supervisedId: string };

const tx = {
  supervision: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    update: vi.fn(),
  },
  appUsageDay: { deleteMany: vi.fn() },
};
const prisma = {
  user: {
    findFirst: vi.fn(async (): Promise<Person | null> => null),
    findMany: vi.fn(async (): Promise<Person[]> => []),
  },
  supervision: {
    findMany: vi.fn(async (): Promise<Link[]> => []),
    findUnique: vi.fn(async (): Promise<unknown> => null),
  },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const push = { canPush: vi.fn(() => true), pushToMember: vi.fn(async () => 1), pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);
const phones = { phoneSummaries: vi.fn(async () => new Map()), refreshPhoneAlerts: vi.fn() };
vi.mock('@/server/services/phoneStatusService', () => phones);
const usage = { usageSummaries: vi.fn(async () => new Map()) };
vi.mock('@/server/services/appUsageService', () => usage);

const {
  dropBrokenSupervision,
  getSupervision,
  isSupervising,
  lookAfterOverview,
  releaseIfUnsupervised,
  ringPhone,
  setRequiredSharing,
  setSupervisors,
  setUsageSharing,
} = await import('./supervisionService');

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
    // Who gets Sam's phone alerts changed with it.
    expect(phones.refreshPhoneAlerts).toHaveBeenCalledWith(H, expect.any(Date), ['sam']);
  });

  it('can clear everyone, which gives required sharing back to them', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(jo);
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisorId: 'alex', supervisedId: 'jo' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'jo', role: 'teen', locationSharing: 'required' }]);
    await setSupervisors(H, head, { supervisedId: 'jo', supervisorIds: [] });
    expect(tx.supervision.createMany).not.toHaveBeenCalled();
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'jo' }, data: { locationSharing: 'on' } });
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

  it('gives a kid who grew up their sharing back', async () => {
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'adult', locationSharing: 'required' }]);
    await dropBrokenSupervision(tx as never, 'sam', 'adult');
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { locationSharing: 'on' } });
  });

  it('checks the kids of a supervisor who lost the role', async () => {
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisedId: 'sam' }, { supervisedId: 'jo' }]);
    await dropBrokenSupervision(tx as never, 'alex', 'teen');
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['sam', 'jo'] }, OR: [{ locationSharing: 'required' }, { shareAppUsage: true }] },
      }),
    );
  });
});

describe('releaseIfUnsupervised', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps required sharing while another adult still supervises them', async () => {
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'required' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'manager' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('lets it go when the only supervisor left is no longer an adult', async () => {
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'required' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'teen' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { locationSharing: 'on' } });
    expect(tx.appUsageDay.deleteMany).not.toHaveBeenCalled();
  });

  it('stops sharing app usage, and deletes it, when nobody is left to see it', async () => {
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on', shareAppUsage: true }]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { shareAppUsage: null } });
    expect(tx.appUsageDay.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });
  });
});

describe('required sharing', () => {
  const findLinks = prisma.supervision.findMany as unknown as ReturnType<typeof vi.fn>;
  const linkTo = (kid: Person, locationSharing: string | null) => [
    { supervisor: { role: 'adult' }, supervised: { ...kid, locationSharing } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    findLinks.mockReset();
    findLinks.mockResolvedValue([]);
  });

  it('lists the people the viewer looks after with their sharing', async () => {
    findLinks.mockResolvedValueOnce([...linkTo(sam, 'required'), ...linkTo(jo, null), { supervisor: { role: 'adult' }, supervised: { ...alex, locationSharing: 'on' } }]);
    expect(await lookAfterOverview(H, 'alex')).toEqual({
      canRing: true,
      people: [
        { id: 'jo', name: 'Jo', sharing: 'off', phone: null, appUsage: { shared: false, latest: null } },
        { id: 'sam', name: 'Sam', sharing: 'required', phone: null, appUsage: { shared: false, latest: null } },
      ],
    });
  });

  it('shows each one’s phone, and their app usage only where it is shared', async () => {
    findLinks.mockResolvedValueOnce([
      { supervisor: { role: 'adult' }, supervised: { ...sam, locationSharing: 'on', shareAppUsage: true } },
      { supervisor: { role: 'adult' }, supervised: { ...jo, locationSharing: 'on', shareAppUsage: null } },
    ]);
    const phone = { lastSeenAt: '2026-10-12T17:00:00.000Z', deviceName: 'Pixel 8', problems: ['quiet'] };
    const latest = { day: '2026-10-12', totalMinutes: 30, top: [], updatedAt: '2026-10-12T17:00:00.000Z' };
    phones.phoneSummaries.mockResolvedValueOnce(new Map([['sam', phone]]));
    usage.usageSummaries.mockResolvedValueOnce(new Map([['sam', latest]]));
    const { people } = await lookAfterOverview(H, 'alex');
    // Jo's usage isn't shared, so it isn't even looked up.
    expect(usage.usageSummaries).toHaveBeenCalledWith(['sam']);
    expect(people).toEqual([
      { id: 'jo', name: 'Jo', sharing: 'on', phone: null, appUsage: { shared: false, latest: null } },
      { id: 'sam', name: 'Sam', sharing: 'on', phone, appUsage: { shared: true, latest } },
    ]);
  });

  it('a supervisor makes it required, logs it, and wakes their phone', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'off'));
    await setRequiredSharing(H, { id: 'alex' }, { supervisedId: 'sam', required: true });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { locationSharing: 'required' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'made Sam’s location sharing required' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'location');
  });

  it('stopping it leaves sharing on, for them to turn off', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'required'));
    await setRequiredSharing(H, { id: 'alex' }, { supervisedId: 'sam', required: false });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { locationSharing: 'on' } });
    expect(phones.refreshPhoneAlerts).toHaveBeenCalledWith(H, expect.any(Date), ['sam']);
  });

  it('does nothing when it is already so, and never turns sharing on by stopping', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'off'));
    await setRequiredSharing(H, { id: 'alex' }, { supervisedId: 'sam', required: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('refuses anyone who does not supervise them', async () => {
    findLinks.mockResolvedValueOnce(linkTo(jo, 'off'));
    await expect(setRequiredSharing(H, { id: 'gran' }, { supervisedId: 'sam', required: true })).rejects.toThrow(
      /Only an adult who supervises/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a supervisor turns app usage sharing on, and off again deletes what was stored', async () => {
    findLinks.mockResolvedValueOnce([{ supervisor: { role: 'adult' }, supervised: { ...sam, shareAppUsage: null } }]);
    await setUsageSharing(H, { id: 'alex' }, { supervisedId: 'sam', share: true });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { shareAppUsage: true } });
    expect(tx.appUsageDay.deleteMany).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'turned on sharing Sam’s app usage' }), tx);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'usage');

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce([{ supervisor: { role: 'adult' }, supervised: { ...sam, shareAppUsage: true } }]);
    await setUsageSharing(H, { id: 'alex' }, { supervisedId: 'sam', share: false });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { shareAppUsage: null } });
    expect(tx.appUsageDay.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });
    // Its "Usage access off" alert can't stand any more: refreshed now, not at the next sweep.
    expect(phones.refreshPhoneAlerts).toHaveBeenCalledWith(H, expect.any(Date), ['sam']);
  });

  it('refuses app usage sharing from anyone who does not supervise them', async () => {
    findLinks.mockResolvedValueOnce([]);
    await expect(setUsageSharing(H, { id: 'jordan' }, { supervisedId: 'sam', share: true })).rejects.toThrow(
      /Only an adult who supervises/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('knows a supervisor only while both roles fit', async () => {
    prisma.supervision.findUnique.mockResolvedValueOnce({ supervisor: { role: 'adult' }, supervised: { role: 'teen' } });
    expect(await isSupervising('alex', 'jo')).toBe(true);
    prisma.supervision.findUnique.mockResolvedValueOnce({ supervisor: { role: 'guest' }, supervised: { role: 'teen' } });
    expect(await isSupervising('alex', 'jo')).toBe(false);
    prisma.supervision.findUnique.mockResolvedValueOnce(null);
    expect(await isSupervising('alex', 'jo')).toBe(false);
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
