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
  blockedApp: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  appLimit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  appSchedule: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  pointsForTime: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  extraTime: { create: vi.fn() },
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
  blockedApp: { findUnique: vi.fn(async (): Promise<unknown> => null) },
  appSchedule: { findFirst: vi.fn(async (): Promise<unknown> => null), count: vi.fn(async () => 0) },
  pointsForTime: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findUnique: vi.fn(async (): Promise<unknown> => null),
  },
  appLimit: { findUnique: vi.fn(async (): Promise<unknown> => null), count: vi.fn(async () => 1) },
  phoneStatus: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn();
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const push = { canPush: vi.fn(() => true), pushToMember: vi.fn(async () => 1), pushSync: vi.fn() };
vi.mock('@/server/services/pushService', () => push);
const phones = {
  phoneSummaries: vi.fn(async () => new Map()),
  refreshPhoneAlerts: vi.fn(),
  SUPERVISED_SELECT: {
    locationSharing: true,
    shareAppUsage: true,
    requireKeepRunning: true,
    requirePreventUninstall: true,
    requireBatteryUnrestricted: true,
    webFilter: true,
  },
};
vi.mock('@/server/services/phoneStatusService', () => phones);
const usage = {
  usageSummaries: vi.fn(async () => new Map()),
  forgetUsage: vi.fn(),
  usageNamesApp: vi.fn(async () => false),
  findIcon: vi.fn(async (): Promise<Uint8Array | null> => null),
  usageHistory: vi.fn(async (): Promise<unknown> => ({ days: [] })),
  usageLabel: vi.fn(async (): Promise<string | null> => null),
  usageApps: vi.fn(async (): Promise<Map<string, unknown[]>> => new Map()),
};
vi.mock('@/server/services/appUsageService', () => usage);
const blocks = {
  blockedAppsByKid: vi.fn(async (): Promise<Map<string, unknown[]>> => new Map()),
  isBlockedFor: vi.fn(async () => false),
  namesOf: vi.fn(async (): Promise<Map<string, string>> => new Map([['alex', 'Alex']])),
};
vi.mock('@/server/services/appBlockService', () => blocks);
const limits = {
  appLimitsByKid: vi.fn(async (): Promise<Map<string, unknown[]>> => new Map()),
  isLimitedFor: vi.fn(async () => false),
};
vi.mock('@/server/services/appLimitService', () => limits);
const schedules = {
  schedulesByKid: vi.fn(async (): Promise<Map<string, unknown[]>> => new Map()),
  isScheduledFor: vi.fn(async () => false),
  allowedApps: (raw: string) => JSON.parse(raw) as { app: string; label: string }[],
};
vi.mock('@/server/services/appScheduleService', () => schedules);
const pointsTime = {
  pointsBalances: vi.fn(async (_db: unknown, _h: string, ids: string[]) => new Map(ids.map((id) => [id, 0]))),
  minutesOn: vi.fn<(db: unknown, id: string) => Promise<{ bought: number; given: number }>>(async () => ({ bought: 0, given: 0 })),
};
vi.mock('@/server/services/pointsTimeService', () => pointsTime);
const points = {
  getPointsSettings: vi.fn(async () => ({ minutesPerPoint: 10, timezone: 'America/Chicago', weekStartsOn: 0 })),
  todayIn: vi.fn(() => '2026-10-12'),
};
vi.mock('@/server/services/pointsService', () => points);
const admin = { isFeatureEnabled: vi.fn(async () => true) };
vi.mock('@/server/services/serverAdminService', () => admin);

const {
  dropBrokenSupervision,
  getSupervision,
  isSupervising,
  linkNewSupervisors,
  lookAfterOverview,
  newMemberSupervisors,
  releaseIfUnsupervised,
  refreshUsage,
  reportRing,
  ringPhone,
  setAppBlocked,
  setAppLimit,
  saveSchedule,
  removeSchedule,
  setPhoneRule,
  setPointsForTime,
  giveExtraTime,
  setRequiredSharing,
  setSupervisors,
  setUsageSharing,
  setWebFilter,
  supervisedUsageHistory,
  usageIcon,
} = await import('./supervisionService');

const H = 'household1';
const head = { id: 'head', role: 'head' };
const pat: Person = { id: 'head', name: 'Pat', role: 'head' };
const alex: Person = { id: 'alex', name: 'Alex', role: 'adult' };
const gran: Person = { id: 'gran', name: 'Gran', role: 'manager' };
const sam: Person = { id: 'sam', name: 'Sam', role: 'child' };
const jo: Person = { id: 'jo', name: 'Jo', role: 'teen' };
const guest: Person = { id: 'guest', name: 'Guest', role: 'guest' };
const ALL_RULES = { keepRunning: true, preventUninstall: true, batteryUnrestricted: true };
const NO_BLOCKS = { apps: [], alwaysAllowed: [], works: null };
const NO_LIMITS = { total: null, apps: [], counts: null };
const NO_POINTS_TIME = { available: true, rule: null, balanceCenti: 0, day: '2026-10-12', bought: 0, given: 0 };

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

describe('newMemberSupervisors (Add a member)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checks nothing when nobody was ticked, whoever adds them', async () => {
    const manager = { id: 'gran', role: 'manager' };
    await expect(newMemberSupervisors(H, manager, 'child', undefined)).resolves.toEqual([]);
    await expect(newMemberSupervisors(H, manager, 'adult', [])).resolves.toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('is for the Head of House only', async () => {
    await expect(newMemberSupervisors(H, { id: 'gran', role: 'manager' }, 'child', ['gran'])).rejects.toThrow(
      /Only the Head of House/,
    );
  });

  it('only for a child or teen', async () => {
    await expect(newMemberSupervisors(H, head, 'adult', ['head'])).rejects.toThrow(/Only children and teens/);
  });

  it('refuses a supervisor from another household or below adult', async () => {
    prisma.user.findMany.mockResolvedValueOnce([alex]);
    await expect(newMemberSupervisors(H, head, 'child', ['alex', 'stranger'])).rejects.toThrow(
      /not in this household/,
    );
    prisma.user.findMany.mockResolvedValueOnce([jo]);
    await expect(newMemberSupervisors(H, head, 'teen', ['jo'])).rejects.toThrow(/Jo can’t supervise anyone/);
  });

  it('gives the supervisors highest role first, each once', async () => {
    prisma.user.findMany.mockResolvedValueOnce([alex, pat]);
    const got = await newMemberSupervisors(H, head, 'child', ['alex', 'head', 'alex']);
    expect(got.map((s) => s.id)).toEqual(['head', 'alex']);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['alex', 'head'] }, householdId: H } }),
    );
  });

  it('saves the links for the new member', async () => {
    await linkNewSupervisors(tx as never, H, 'head', 'newkid', [pat, alex]);
    expect(tx.supervision.createMany).toHaveBeenCalledWith({
      data: [
        { householdId: H, supervisorId: 'head', supervisedId: 'newkid', createdById: 'head' },
        { householdId: H, supervisorId: 'alex', supervisedId: 'newkid', createdById: 'head' },
      ],
    });
    tx.supervision.createMany.mockClear();
    await linkNewSupervisors(tx as never, H, 'head', 'newkid', []);
    expect(tx.supervision.createMany).not.toHaveBeenCalled();
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
    // Sam's phone checks in at once, to learn it must now Stay connected.
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
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
    expect(push.pushSync).not.toHaveBeenCalled();
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
        where: {
          id: { in: ['sam', 'jo'] },
          OR: [{ locationSharing: 'required' }, { shareAppUsage: true }, { webFilter: { not: null } }, { id: { in: [] } }],
        },
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
    expect(usage.forgetUsage).not.toHaveBeenCalled();
  });

  it('stops sharing app usage, and deletes it, when nobody is left to see it', async () => {
    tx.user.findMany.mockResolvedValueOnce([
      { id: 'sam', role: 'child', householdId: H, locationSharing: 'on', shareAppUsage: true },
    ]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { shareAppUsage: null } });
    // Their days, and the icons nobody else's usage names.
    expect(usage.forgetUsage).toHaveBeenCalledWith(tx, H, ['sam']);
  });

  it('unblocks every app when nobody is left to supervise them, before their usage goes', async () => {
    tx.blockedApp.findMany.mockResolvedValueOnce([{ userId: 'sam' }, { userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([
      { id: 'sam', role: 'child', householdId: H, locationSharing: 'on', shareAppUsage: true },
    ]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam', 'sam']);
    // Someone with blocks counts even when nothing else is controlled.
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['sam'] },
          OR: [{ locationSharing: 'required' }, { shareAppUsage: true }, { webFilter: { not: null } }, { id: { in: ['sam'] } }],
        },
      }),
    );
    expect(tx.blockedApp.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });
    expect(tx.blockedApp.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      usage.forgetUsage.mock.invocationCallOrder[0],
    );
  });

  it('removes every limit when nobody is left to supervise them', async () => {
    tx.appLimit.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', householdId: H, locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    // Someone with limits counts even when nothing else is controlled.
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['sam'] },
          OR: [{ locationSharing: 'required' }, { shareAppUsage: true }, { webFilter: { not: null } }, { id: { in: ['sam'] } }],
        },
      }),
    );
    expect(tx.appLimit.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });
    expect(tx.blockedApp.deleteMany).not.toHaveBeenCalled();
  });

  it('removes every schedule when nobody is left to supervise them, and keeps them otherwise', async () => {
    tx.appSchedule.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', householdId: H, locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['sam'] },
          OR: [{ locationSharing: 'required' }, { shareAppUsage: true }, { webFilter: { not: null } }, { id: { in: ['sam'] } }],
        },
      }),
    );
    expect(tx.appSchedule.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });

    vi.clearAllMocks();
    tx.appSchedule.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'adult' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.appSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('stops points for time when nobody is left to supervise them', async () => {
    tx.pointsForTime.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', householdId: H, locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.pointsForTime.deleteMany).toHaveBeenCalledWith({ where: { userId: 'sam' } });
  });

  it('keeps the limits while another adult still supervises them', async () => {
    tx.appLimit.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'adult' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.appLimit.deleteMany).not.toHaveBeenCalled();
  });

  it('turns the web filter off when nobody is left to supervise them, and keeps it otherwise', async () => {
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on', webFilter: 'family' }]);
    tx.supervision.findMany.mockResolvedValueOnce([]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { webFilter: null } });

    vi.clearAllMocks();
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on', webFilter: 'family' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'adult' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('keeps the blocks while another adult still supervises them', async () => {
    tx.blockedApp.findMany.mockResolvedValueOnce([{ userId: 'sam' }]);
    tx.user.findMany.mockResolvedValueOnce([{ id: 'sam', role: 'child', locationSharing: 'on' }]);
    tx.supervision.findMany.mockResolvedValueOnce([{ supervisor: { role: 'adult' } }]);
    await releaseIfUnsupervised(tx as never, ['sam']);
    expect(tx.blockedApp.deleteMany).not.toHaveBeenCalled();
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
    // No phone yet: every required step waits, in the app's order.
    const waiting = (...steps: string[]) => ({
      passwordChosen: true,
      steps: steps.map((step) => ({ step, done: null })),
    });
    expect(await lookAfterOverview(H, 'alex')).toEqual({
      canRing: true,
      people: [
        {
          id: 'jo',
          name: 'Jo',
          sharing: 'off',
          phone: null,
          appUsage: { shared: false, latest: null },
          rules: ALL_RULES,
          webFilter: { filter: null, on: null },
          blocking: NO_BLOCKS,
          usageApps: [],
          limits: NO_LIMITS,
          schedules: [],
          pointsTime: NO_POINTS_TIME,
          setup: waiting('notifications', 'batteryUnrestricted', 'preventUninstall', 'keepRunning'),
          ring: null,
        },
        {
          id: 'sam',
          name: 'Sam',
          sharing: 'required',
          phone: null,
          appUsage: { shared: false, latest: null },
          rules: ALL_RULES,
          webFilter: { filter: null, on: null },
          blocking: NO_BLOCKS,
          usageApps: [],
          limits: NO_LIMITS,
          schedules: [],
          pointsTime: NO_POINTS_TIME,
          setup: waiting('notifications', 'location', 'batteryUnrestricted', 'preventUninstall', 'keepRunning'),
          ring: null,
        },
      ],
    });
  });

  it('leaves location out of the setup steps while the household has Location off', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'required'));
    admin.isFeatureEnabled.mockResolvedValueOnce(false);
    const { people } = await lookAfterOverview(H, 'alex');
    expect(people[0].setup.steps.map((s) => s.step)).toEqual([
      'notifications',
      'batteryUnrestricted',
      'preventUninstall',
      'keepRunning',
    ]);
  });

  it('shows the web filter chosen, whether their phone uses it, and asks for it in setup', async () => {
    findLinks.mockResolvedValueOnce([
      { supervisor: { role: 'adult' }, supervised: { ...sam, locationSharing: 'on', webFilter: 'family' } },
    ]);
    const checks = {
      notifications: true,
      location: true,
      batteryUnrestricted: true,
      usageAccess: true,
      webFilter: false,
      preventUninstall: true,
      keepRunning: true,
    };
    phones.phoneSummaries.mockResolvedValueOnce(
      new Map([['sam', { lastSeenAt: '2026-10-12T17:00:00.000Z', problems: ['web_filter_off'], checks, alwaysAllowed: [] }]]),
    );
    const [person] = (await lookAfterOverview(H, 'alex')).people;
    expect(person.webFilter).toEqual({ filter: 'family', on: false });
    expect(person.setup.steps).toContainEqual({ step: 'webFilter', done: false });
  });

  it('shows each one’s phone, their app usage only where it is shared, and their phone rules', async () => {
    findLinks.mockResolvedValueOnce([
      {
        supervisor: { role: 'adult' },
        supervised: {
          ...sam,
          locationSharing: 'on',
          shareAppUsage: true,
          requirePreventUninstall: false,
          mustChangePassword: true,
        },
      },
      { supervisor: { role: 'adult' }, supervised: { ...jo, locationSharing: 'on', shareAppUsage: null } },
    ]);
    const phone = { lastSeenAt: '2026-10-12T17:00:00.000Z', deviceName: 'Pixel 8', problems: ['quiet'] };
    const checks = {
      notifications: true,
      location: true,
      batteryUnrestricted: false,
      usageAccess: true,
      preventUninstall: null,
      keepRunning: true,
    };
    const latest = { day: '2026-10-12', totalMinutes: 30, top: [], updatedAt: '2026-10-12T17:00:00.000Z' };
    const roblox = { app: 'com.roblox.client', label: 'Roblox', icon: true, byName: 'Alex', at: '2026-10-12T16:00:00.000Z' };
    phones.phoneSummaries.mockResolvedValueOnce(
      new Map([['sam', { ...phone, checks, alwaysAllowed: ['com.google.android.dialer'] }]]),
    );
    usage.usageSummaries.mockResolvedValueOnce(new Map([['sam', latest]]));
    blocks.blockedAppsByKid.mockResolvedValueOnce(new Map([['sam', [roblox]]]));
    const allApps = { app: '*', label: 'All apps', icon: false, minutes: 180, byName: 'Alex', at: '2026-10-12T15:00:00.000Z' };
    const youtube = { app: 'com.google.android.youtube', label: 'YouTube', icon: true, minutes: 60, byName: 'Pat', at: '2026-10-12T14:00:00.000Z' };
    limits.appLimitsByKid.mockResolvedValueOnce(new Map([['sam', [allApps, youtube]]]));
    const bedtime = { id: 's1', name: 'Bedtime', days: [0, 6], start: 1260, end: 420, allowed: [], byName: 'Alex', at: '2026-10-12T13:00:00.000Z' };
    schedules.schedulesByKid.mockResolvedValueOnce(new Map([['sam', [bedtime]]]));
    prisma.pointsForTime.findMany.mockResolvedValueOnce([
      { userId: 'sam', minutesPerPoint: 5, dailyCap: 30, setById: 'alex', updatedAt: new Date('2026-10-12T12:00:00Z') },
    ]);
    pointsTime.pointsBalances.mockResolvedValueOnce(new Map([['jo', 0], ['sam', 1250]]));
    pointsTime.minutesOn.mockImplementation(async (_db: unknown, id: string) =>
      id === 'sam' ? { bought: 15, given: 10 } : { bought: 0, given: 0 },
    );
    usage.usageApps.mockResolvedValueOnce(
      new Map([
        [
          'sam',
          [
            { app: 'com.google.android.dialer', label: 'Phone', icon: false },
            { app: 'com.roblox.client', label: 'Roblox', icon: true },
            { app: 'com.google.android.youtube', label: 'YouTube', icon: true },
          ],
        ],
      ]),
    );
    const { people } = await lookAfterOverview(H, 'alex');
    // Jo's usage isn't shared, so it isn't even looked up; blocks and limits are looked up for both.
    expect(usage.usageSummaries).toHaveBeenCalledWith(H, ['sam']);
    expect(usage.usageApps).toHaveBeenCalledWith(H, ['sam']);
    expect(blocks.blockedAppsByKid).toHaveBeenCalledWith(H, ['jo', 'sam']);
    expect(limits.appLimitsByKid).toHaveBeenCalledWith(H, ['jo', 'sam']);
    expect(schedules.schedulesByKid).toHaveBeenCalledWith(H, ['jo', 'sam']);
    expect(people).toEqual([
      {
        id: 'jo',
        name: 'Jo',
        sharing: 'on',
        phone: null,
        appUsage: { shared: false, latest: null },
        rules: ALL_RULES,
        webFilter: { filter: null, on: null },
        blocking: NO_BLOCKS,
        usageApps: [],
        limits: NO_LIMITS,
        schedules: [],
        pointsTime: NO_POINTS_TIME,
        setup: {
          passwordChosen: true,
          steps: ['notifications', 'batteryUnrestricted', 'preventUninstall', 'keepRunning'].map((step) => ({
            step,
            done: null,
          })),
        },
        ring: null,
      },
      {
        id: 'sam',
        name: 'Sam',
        sharing: 'on',
        // The checks and the always-open apps only feed setup and blocking.
        phone,
        appUsage: { shared: true, latest },
        rules: { ...ALL_RULES, preventUninstall: false },
        webFilter: { filter: null, on: null },
        // Keep Our Home running is on, which does the blocking.
        blocking: { apps: [roblox], alwaysAllowed: ['com.google.android.dialer'], works: true },
        // Every app from their usage except the ones their phone keeps open; Usage access counts.
        usageApps: [
          { app: 'com.roblox.client', label: 'Roblox', icon: true },
          { app: 'com.google.android.youtube', label: 'YouTube', icon: true },
        ],
        limits: { total: allApps, apps: [youtube], counts: true },
        schedules: [bedtime],
        pointsTime: {
          available: true,
          rule: { minutesPerPoint: 5, dailyCap: 30, byName: 'Alex', at: '2026-10-12T12:00:00.000Z' },
          balanceCenti: 1250,
          day: '2026-10-12',
          bought: 15,
          given: 10,
        },
        // Location isn't required and Prevent uninstall isn't either, so neither is a step.
        setup: {
          passwordChosen: false,
          steps: [
            { step: 'notifications', done: true },
            { step: 'batteryUnrestricted', done: false },
            { step: 'usageAccess', done: true },
            { step: 'keepRunning', done: true },
          ],
        },
        ring: null,
      },
    ]);
  });

  it('a supervisor stops requiring a protection: stored as off, logged, phone woken, alerts refreshed', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setPhoneRule(H, { id: 'alex' }, { supervisedId: 'sam', rule: 'preventUninstall', required: false });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { requirePreventUninstall: false } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'stopped requiring Prevent uninstall on Sam’s phone' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
    expect(phones.refreshPhoneAlerts).toHaveBeenCalledWith(H, expect.any(Date), ['sam']);
  });

  it('requiring it again stores the default (null), and an unchanged rule writes nothing', async () => {
    findLinks.mockResolvedValueOnce([
      { supervisor: { role: 'adult' }, supervised: { ...sam, locationSharing: 'on', requireKeepRunning: false } },
    ]);
    await setPhoneRule(H, { id: 'alex' }, { supervisedId: 'sam', rule: 'keepRunning', required: true });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { requireKeepRunning: null } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'required Keep Our Home running on Sam’s phone' }),
      tx,
    );

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setPhoneRule(H, { id: 'alex' }, { supervisedId: 'sam', rule: 'batteryUnrestricted', required: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('a supervisor chooses a web filter: stored, logged, phone woken, alerts refreshed', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setWebFilter(H, { id: 'alex' }, { supervisedId: 'sam', filter: 'family' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { webFilter: 'family' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'set Sam’s web filter to Family filter' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
    expect(phones.refreshPhoneAlerts).toHaveBeenCalledWith(H, expect.any(Date), ['sam']);
  });

  it('turning the web filter off stores null, and an unchanged filter writes nothing', async () => {
    findLinks.mockResolvedValueOnce([
      { supervisor: { role: 'adult' }, supervised: { ...sam, locationSharing: 'on', webFilter: 'adult' } },
    ]);
    await setWebFilter(H, { id: 'alex' }, { supervisedId: 'sam', filter: 'off' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { webFilter: null } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'turned off the web filter on Sam’s phone' }),
      tx,
    );

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce([
      { supervisor: { role: 'adult' }, supervised: { ...sam, locationSharing: 'on', webFilter: 'adult' } },
    ]);
    await setWebFilter(H, { id: 'alex' }, { supervisedId: 'sam', filter: 'adult' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('refuses a web filter from someone who doesn’t supervise them', async () => {
    findLinks.mockResolvedValueOnce([]);
    await expect(setWebFilter(H, { id: 'gran' }, { supervisedId: 'sam', filter: 'family' })).rejects.toThrow(
      /Only an adult who supervises them/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a phone rule from someone who doesn’t supervise them', async () => {
    findLinks.mockResolvedValueOnce([]);
    await expect(
      setPhoneRule(H, { id: 'gran' }, { supervisedId: 'sam', rule: 'keepRunning', required: false }),
    ).rejects.toThrow(/Only an adult who supervises them/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    expect(usage.forgetUsage).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'turned on sharing Sam’s app usage' }), tx);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'usage');

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce([{ supervisor: { role: 'adult' }, supervised: { ...sam, shareAppUsage: true } }]);
    await setUsageSharing(H, { id: 'alex' }, { supervisedId: 'sam', share: false });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'sam' }, data: { shareAppUsage: null } });
    expect(usage.forgetUsage).toHaveBeenCalledWith(tx, H, ['sam']);
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

  it('a supervisor blocks an app from their usage: named from it, logged, phone woken', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.phoneStatus.findMany.mockResolvedValueOnce([
      { lastSeenAt: new Date('2026-10-12T10:00:00Z'), alwaysAllowed: ['com.roblox.client'] },
      // The freshest phone decides what's always open.
      { lastSeenAt: new Date('2026-10-12T17:00:00Z'), alwaysAllowed: ['com.google.android.dialer'] },
    ]);
    usage.usageLabel.mockResolvedValueOnce('Roblox');
    await setAppBlocked(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.roblox.client', blocked: true });
    expect(usage.usageLabel).toHaveBeenCalledWith('sam', 'com.roblox.client');
    expect(tx.blockedApp.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'sam', app: 'com.roblox.client', label: 'Roblox', blockedById: 'alex' },
    });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'blocked Roblox on Sam’s phone' }), tx);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('never blocks an app their phone always keeps open', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.phoneStatus.findMany.mockResolvedValueOnce([
      { lastSeenAt: new Date('2026-10-12T17:00:00Z'), alwaysAllowed: ['com.google.android.dialer'] },
    ]);
    await expect(
      setAppBlocked(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.google.android.dialer', blocked: true }),
    ).rejects.toThrow(/phone calls, messages, the home screen and OurHome can’t be blocked/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('only blocks an app their usage names', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    usage.usageLabel.mockResolvedValueOnce(null);
    await expect(
      setAppBlocked(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.made.up', blocked: true }),
    ).rejects.toThrow(/isn’t in Sam’s app usage/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('unblocks with the stored name, even once it has left their usage', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.blockedApp.findUnique.mockResolvedValueOnce({ id: 'b1', label: 'Roblox' });
    await setAppBlocked(H, { id: 'gran' }, { supervisedId: 'sam', app: 'com.roblox.client', blocked: false });
    expect(prisma.blockedApp.findUnique).toHaveBeenCalledWith({
      where: { userId_app: { userId: 'sam', app: 'com.roblox.client' } },
      select: { id: true, label: true },
    });
    expect(usage.usageLabel).not.toHaveBeenCalled();
    expect(tx.blockedApp.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'unblocked Roblox on Sam’s phone' }), tx);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('writes nothing when the app is already so', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.blockedApp.findUnique.mockResolvedValueOnce({ id: 'b1', label: 'Roblox' });
    await setAppBlocked(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.roblox.client', blocked: true });
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setAppBlocked(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.roblox.client', blocked: false });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('refuses blocking from anyone who does not supervise them', async () => {
    findLinks.mockResolvedValueOnce(linkTo(jo, 'on'));
    await expect(
      setAppBlocked(H, { id: 'jordan' }, { supervisedId: 'sam', app: 'com.roblox.client', blocked: true }),
    ).rejects.toThrow(/Only an adult who supervises them can block apps/);
    expect(prisma.blockedApp.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a supervisor gives an app from their usage a daily limit: named from it, logged, phone woken', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    usage.usageLabel.mockResolvedValueOnce('YouTube');
    await setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.google.android.youtube', minutes: 60 });
    expect(prisma.appLimit.findUnique).toHaveBeenCalledWith({
      where: { userId_app: { userId: 'sam', app: 'com.google.android.youtube' } },
      select: { id: true, label: true, minutes: true },
    });
    expect(tx.appLimit.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'sam', app: 'com.google.android.youtube', label: 'YouTube', minutes: 60, setById: 'alex' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'limited YouTube to 1 h a day on Sam’s phone' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('gives all apps together a limit without looking at their usage', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: '*', minutes: 180 });
    expect(usage.usageLabel).not.toHaveBeenCalled();
    expect(prisma.phoneStatus.findMany).not.toHaveBeenCalled();
    expect(tx.appLimit.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'sam', app: '*', label: 'All apps', minutes: 180, setById: 'alex' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'limited all apps to 3 h a day on Sam’s phone' }),
      tx,
    );
  });

  it('changes a limit, and the adult who changed it is the one named', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appLimit.findUnique.mockResolvedValueOnce({ id: 'l1', label: 'YouTube', minutes: 60 });
    await setAppLimit(H, { id: 'gran' }, { supervisedId: 'sam', app: 'com.google.android.youtube', minutes: 90 });
    expect(usage.usageLabel).not.toHaveBeenCalled();
    expect(tx.appLimit.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { minutes: 90, setById: 'gran' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'changed the limit for YouTube to 1 h 30 min a day on Sam’s phone' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('removes a limit with its stored name, even once the app has left their usage', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appLimit.findUnique.mockResolvedValueOnce({ id: 'l1', label: 'All apps', minutes: 180 });
    await setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: '*', minutes: null });
    expect(tx.appLimit.delete).toHaveBeenCalledWith({ where: { id: 'l1' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'removed the daily limit for all apps on Sam’s phone' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('writes nothing for a limit that is already so, or a missing one removed', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appLimit.findUnique.mockResolvedValueOnce({ id: 'l1', label: 'YouTube', minutes: 60 });
    await setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.google.android.youtube', minutes: 60 });
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.google.android.youtube', minutes: null });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('never limits an app their phone always keeps open, nor one their usage doesn’t name', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.phoneStatus.findMany.mockResolvedValueOnce([
      { lastSeenAt: new Date('2026-10-12T17:00:00Z'), alwaysAllowed: ['com.google.android.dialer'] },
    ]);
    await expect(
      setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.google.android.dialer', minutes: 30 }),
    ).rejects.toThrow(/phone calls, messages, the home screen and OurHome have no limit/);
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    usage.usageLabel.mockResolvedValueOnce(null);
    await expect(
      setAppLimit(H, { id: 'alex' }, { supervisedId: 'sam', app: 'com.made.up', minutes: 30 }),
    ).rejects.toThrow(/isn’t in Sam’s app usage/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('refuses limits from anyone who does not supervise them', async () => {
    findLinks.mockResolvedValueOnce(linkTo(jo, 'on'));
    await expect(
      setAppLimit(H, { id: 'jordan' }, { supervisedId: 'sam', app: '*', minutes: 60 }),
    ).rejects.toThrow(/Only an adult who supervises them can set limits/);
    expect(prisma.appLimit.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a supervisor adds a schedule: allowed apps named from their usage, logged, phone woken', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    usage.usageApps.mockResolvedValueOnce(new Map([['sam', [{ app: 'com.google.android.apps.maps', label: 'Maps', icon: false }]]]));
    await saveSchedule(H, { id: 'alex' }, {
      supervisedId: 'sam',
      name: 'Bedtime',
      days: [6, 0, 1, 2, 3, 4, 5, 5],
      start: 1260,
      end: 420,
      allowed: ['com.google.android.apps.maps'],
    });
    expect(tx.appSchedule.create).toHaveBeenCalledWith({
      data: {
        householdId: H,
        userId: 'sam',
        name: 'Bedtime',
        days: [0, 1, 2, 3, 4, 5, 6],
        start: 1260,
        end: 420,
        allowed: JSON.stringify([{ app: 'com.google.android.apps.maps', label: 'Maps' }]),
        setById: 'alex',
      },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'added Bedtime to Sam’s phone (Every day, 9:00 PM to 7:00 AM)' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');
  });

  it('changes a schedule, keeping an allowed app that has left their usage, and skips one unchanged', async () => {
    const stored = {
      id: 's1',
      name: 'School',
      days: [1, 2, 3, 4, 5],
      start: 480,
      end: 900,
      allowed: JSON.stringify([{ app: 'com.classroom', label: 'Classroom' }]),
    };
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appSchedule.findFirst.mockResolvedValueOnce(stored);
    await saveSchedule(H, { id: 'gran' }, { supervisedId: 'sam', id: 's1', name: 'School', days: [1, 2, 3, 4, 5], start: 480, end: 930, allowed: ['com.classroom'] });
    expect(prisma.appSchedule.findFirst).toHaveBeenCalledWith({ where: { id: 's1', userId: 'sam' } });
    expect(tx.appSchedule.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: expect.objectContaining({ end: 930, allowed: stored.allowed, setById: 'gran' }),
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'changed School on Sam’s phone (Weekdays, 8:00 AM to 3:30 PM)' }),
      tx,
    );

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appSchedule.findFirst.mockResolvedValueOnce(stored);
    await saveSchedule(H, { id: 'alex' }, { supervisedId: 'sam', id: 's1', name: 'School', days: [5, 4, 3, 2, 1], start: 480, end: 900, allowed: ['com.classroom'] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(push.pushSync).not.toHaveBeenCalled();
  });

  it('refuses an app their usage doesn’t name, a missing schedule, and more than the most', async () => {
    const body = { supervisedId: 'sam', name: 'School', days: [1], start: 480, end: 900, allowed: [] as string[] };
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await expect(saveSchedule(H, { id: 'alex' }, { ...body, allowed: ['com.made.up'] })).rejects.toThrow(
      /isn’t in Sam’s app usage/,
    );
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await expect(saveSchedule(H, { id: 'alex' }, { ...body, id: 'gone' })).rejects.toThrow(/isn’t there any more/);
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appSchedule.count.mockResolvedValueOnce(10);
    await expect(saveSchedule(H, { id: 'alex' }, body)).rejects.toThrow(/Sam has 10 schedules already/);
    findLinks.mockResolvedValueOnce(linkTo(jo, 'on'));
    await expect(saveSchedule(H, { id: 'jordan' }, body)).rejects.toThrow(/Only an adult who supervises them can set schedules/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('removes a schedule, logs it and wakes their phone; a missing one changes nothing', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appSchedule.findFirst.mockResolvedValueOnce({ id: 's1', name: 'Bedtime' });
    await removeSchedule(H, { id: 'alex' }, { supervisedId: 'sam', id: 's1' });
    expect(tx.appSchedule.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'removed Bedtime from Sam’s phone' }), tx);
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await removeSchedule(H, { id: 'alex' }, { supervisedId: 'sam', id: 's1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    findLinks.mockResolvedValueOnce([]);
    await expect(removeSchedule(H, { id: 'jordan' }, { supervisedId: 'sam', id: 's1' })).rejects.toThrow(
      /Only an adult who supervises them/,
    );
  });

  it('lets a child spend points on time, changes the rate, and stops it, logging each', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await setPointsForTime(H, { id: 'alex' }, { supervisedId: 'sam', minutesPerPoint: 5, dailyCap: 30 });
    expect(tx.pointsForTime.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'sam', minutesPerPoint: 5, dailyCap: 30, setById: 'alex' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'let Sam spend points on screen time (1 point = 5 min, up to 30 min a day)' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');

    vi.clearAllMocks();
    const stored = { id: 'p1', minutesPerPoint: 5, dailyCap: 30 };
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.pointsForTime.findUnique.mockResolvedValueOnce(stored);
    await setPointsForTime(H, { id: 'gran' }, { supervisedId: 'sam', minutesPerPoint: 10, dailyCap: 60 });
    expect(tx.pointsForTime.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { minutesPerPoint: 10, dailyCap: 60, setById: 'gran' },
    });

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.pointsForTime.findUnique.mockResolvedValueOnce(stored);
    await setPointsForTime(H, { id: 'alex' }, { supervisedId: 'sam', minutesPerPoint: 5, dailyCap: 30 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.pointsForTime.findUnique.mockResolvedValueOnce(stored);
    await setPointsForTime(H, { id: 'alex' }, { supervisedId: 'sam', minutesPerPoint: null, dailyCap: 30 });
    expect(tx.pointsForTime.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'stopped Sam spending points on screen time' }),
      tx,
    );
  });

  it('refuses points for time without the Points feature, or from someone who doesn’t supervise them', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    admin.isFeatureEnabled.mockResolvedValueOnce(false);
    await expect(
      setPointsForTime(H, { id: 'alex' }, { supervisedId: 'sam', minutesPerPoint: 5, dailyCap: 30 }),
    ).rejects.toThrow(/doesn’t use Points/);
    findLinks.mockResolvedValueOnce([]);
    await expect(
      setPointsForTime(H, { id: 'jordan' }, { supervisedId: 'sam', minutesPerPoint: 5, dailyCap: 30 }),
    ).rejects.toThrow(/Only an adult who supervises them/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('gives extra minutes for today in the household’s time zone, only when there’s a limit', async () => {
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    await giveExtraTime(H, { id: 'alex' }, { supervisedId: 'sam', minutes: 30 });
    expect(tx.extraTime.create).toHaveBeenCalledWith({
      data: { householdId: H, userId: 'sam', day: '2026-10-12', minutes: 30, pointsCenti: 0, byId: 'alex' },
    });
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gave Sam 30 min more screen time today' }),
      tx,
    );
    expect(push.pushSync).toHaveBeenCalledWith(H, { userIds: ['sam'] }, 'supervision');

    vi.clearAllMocks();
    findLinks.mockResolvedValueOnce(linkTo(sam, 'on'));
    prisma.appLimit.count.mockResolvedValueOnce(0);
    await expect(giveExtraTime(H, { id: 'alex' }, { supervisedId: 'sam', minutes: 30 })).rejects.toThrow(
      /Sam has no daily limits/,
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
    const ring = await ringPhone(H, { id: 'alex' }, 'sam', clock);
    expect(push.pushToMember).toHaveBeenCalledWith(
      H,
      'sam',
      { type: 'ring', ringerId: 'alex', ringId: expect.any(String) },
      { ttlSec: 60 },
    );
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'alex', message: 'rang Sam’s phone' }));
    expect(ring).toEqual({ sentAt: new Date(clock).toISOString(), phase: 'sending', stoppedAfterSec: null });
  });

  /** The ring id the last push carried. */
  const lastRingId = () => (push.pushToMember.mock.calls.at(-1) as unknown as [string, string, { ringId: string }])[2].ringId;

  it('shows the adult who rang what the phone said back, and nobody else', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    const ringId = lastRingId();
    const ringOf = async (viewer: string, at: number) => (await lookAfterOverview(H, viewer, at)).people[0].ring;

    expect(reportRing(H, 'sam', { ringId, state: 'ringing' }, clock + 2_000)).toEqual({ known: true });
    expect(await ringOf('alex', clock + 3_000)).toEqual(expect.objectContaining({ phase: 'ringing' }));
    // Another adult who looks after Sam doesn't see Alex's ring.
    expect(await ringOf('gran', clock + 3_000)).toBeNull();

    expect(reportRing(H, 'sam', { ringId, state: 'stopped' }, clock + 9_000)).toEqual({ known: true });
    // A second phone of theirs ringing out later doesn't change it.
    reportRing(H, 'sam', { ringId, state: 'rang_out' }, clock + 32_000);
    expect(await ringOf('alex', clock + 40_000)).toEqual({
      sentAt: new Date(clock).toISOString(),
      phase: 'stopped',
      stoppedAfterSec: 7,
    });
    // Shown for ten minutes.
    expect(await ringOf('alex', clock + 600_000)).toBeNull();
    findLinks.mockReset();
  });

  it('lets them ring again as soon as the phone says it stopped', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    reportRing(H, 'sam', { ringId: lastRingId(), state: 'stopped' }, clock + 5_000);
    await ringPhone(H, { id: 'alex' }, 'sam', clock + 6_000);
    expect(push.pushToMember).toHaveBeenCalledTimes(2);
    findLinks.mockReset();
  });

  it('ignores word about any ring but the child’s own latest one', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    const ringId = lastRingId();
    expect(reportRing(H, 'sam', { ringId: 'an-old-ring', state: 'stopped' }, clock + 1_000)).toEqual({ known: false });
    expect(reportRing(H, 'jo', { ringId, state: 'stopped' }, clock + 1_000)).toEqual({ known: false });
    expect(reportRing('household2', 'sam', { ringId, state: 'stopped' }, clock + 1_000)).toEqual({ known: false });
    expect((await lookAfterOverview(H, 'alex', clock + 2_000)).people[0].ring?.phase).toBe('sending');
    findLinks.mockReset();
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

  it('keeps showing the last ring when a new one reached no phone', async () => {
    findLinks.mockResolvedValue(linksOf(sam));
    await ringPhone(H, { id: 'alex' }, 'sam', clock);
    reportRing(H, 'sam', { ringId: lastRingId(), state: 'rang_out' }, clock + 31_000);
    push.pushToMember.mockResolvedValueOnce(0);
    await expect(ringPhone(H, { id: 'alex' }, 'sam', clock + 40_000)).rejects.toThrow(/Couldn’t reach/);
    expect((await lookAfterOverview(H, 'alex', clock + 41_000)).people[0].ring?.phase).toBe('rang_out');
    findLinks.mockReset();
  });

  it('needs Firebase, or their phone using Stay connected', async () => {
    findLinks.mockResolvedValueOnce(linksOf(sam));
    push.canPush.mockReturnValue(false);
    await expect(ringPhone(H, { id: 'alex' }, 'sam', clock)).rejects.toThrow(/Firebase.*Sam’s phone isn’t using Stay connected/);
    // Asked about Sam's phones in particular, not just the server.
    expect(push.canPush).toHaveBeenCalledWith(H, 'sam');
    expect(push.pushToMember).not.toHaveBeenCalled();
  });
});

describe('fresh app usage when a supervisor looks', () => {
  const findLinks = prisma.supervision.findMany as unknown as ReturnType<typeof vi.fn>;
  const sharing = (kid: Person, shareAppUsage: boolean | null) => [
    { supervisor: { role: 'adult' }, supervised: { ...kid, shareAppUsage } },
  ];
  let clock = 50_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    findLinks.mockReset();
    findLinks.mockResolvedValue([]);
    push.canPush.mockReturnValue(true);
    push.pushToMember.mockResolvedValue(1);
    clock += 3_600_000; // every test well past the last one's cooldown
  });

  it('wakes the child’s phone with a short-lived, normal-priority push, and says it did', async () => {
    findLinks.mockResolvedValueOnce(sharing(sam, true));
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock)).toEqual({ asked: true });
    // Normal: silent high-priority pushes would get the ring demoted.
    expect(push.pushToMember).toHaveBeenCalledWith(
      H,
      'sam',
      { type: 'usage_refresh' },
      { ttlSec: 120, priority: 'normal' },
    );
    // Only reads what the supervisor may already see: not logged.
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('asks the same phone at most every two minutes, quietly', async () => {
    findLinks.mockResolvedValue(sharing(sam, true));
    await refreshUsage(H, { id: 'alex' }, 'sam', clock);
    expect(await refreshUsage(H, { id: 'gran' }, 'sam', clock + 60_000)).toEqual({ asked: false });
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock + 121_000)).toEqual({ asked: true });
    expect(push.pushToMember).toHaveBeenCalledTimes(2);
  });

  it('lets the next look try again at once when no phone answered', async () => {
    findLinks.mockResolvedValue(sharing(sam, true));
    push.pushToMember.mockResolvedValueOnce(0);
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock)).toEqual({ asked: false });
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock + 1000)).toEqual({ asked: true });
  });

  it('does nothing when their usage isn’t shared, or the server can’t push', async () => {
    findLinks.mockResolvedValueOnce(sharing(sam, null));
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock)).toEqual({ asked: false });
    push.canPush.mockReturnValue(false);
    findLinks.mockResolvedValueOnce(sharing(sam, true));
    expect(await refreshUsage(H, { id: 'alex' }, 'sam', clock)).toEqual({ asked: false });
    expect(push.pushToMember).not.toHaveBeenCalled();
  });

  it('refuses anyone who does not supervise them', async () => {
    await expect(refreshUsage(H, { id: 'jordan' }, 'sam', clock)).rejects.toThrow(/Only an adult who supervises/);
    expect(push.pushToMember).not.toHaveBeenCalled();
  });

  it('gives an app’s icon only to a supervisor of a child whose shared usage names it', async () => {
    const png = new Uint8Array([1, 2, 3]);
    findLinks.mockResolvedValueOnce([...sharing(sam, true), ...sharing(jo, null)]);
    usage.usageNamesApp.mockResolvedValueOnce(true);
    usage.findIcon.mockResolvedValueOnce(png);
    expect(await usageIcon(H, 'alex', 'com.roblox.client')).toBe(png);
    // Jo's usage isn't shared, so only Sam's days are searched (and Alex's own, none unless shared).
    expect(usage.usageNamesApp).toHaveBeenCalledWith(['sam', 'alex'], 'com.roblox.client');
    expect(usage.findIcon).toHaveBeenCalledWith(H, 'com.roblox.client');
  });

  it('is not found for an app none of their children’s usage names, even when stored', async () => {
    findLinks.mockResolvedValueOnce(sharing(sam, true));
    usage.usageNamesApp.mockResolvedValueOnce(false);
    usage.findIcon.mockResolvedValue(new Uint8Array([1]));
    await expect(usageIcon(H, 'alex', 'com.example.secret')).rejects.toThrow(/No icon/);
    expect(usage.findIcon).not.toHaveBeenCalled();
    usage.findIcon.mockReset();
  });

  it('gives the icon of an app blocked for a child they supervise, shared or not', async () => {
    const png = new Uint8Array([5]);
    findLinks.mockResolvedValueOnce([...sharing(sam, true), ...sharing(jo, null)]);
    blocks.isBlockedFor.mockResolvedValueOnce(true);
    usage.findIcon.mockResolvedValueOnce(png);
    expect(await usageIcon(H, 'alex', 'com.roblox.client')).toBe(png);
    // Every child they supervise, Jo (teen) first by role.
    expect(blocks.isBlockedFor).toHaveBeenCalledWith(['jo', 'sam'], 'com.roblox.client');
  });

  it('gives the icon of an app with a limit for a child they supervise', async () => {
    const png = new Uint8Array([6]);
    findLinks.mockResolvedValueOnce(sharing(jo, null));
    limits.isLimitedFor.mockResolvedValueOnce(true);
    usage.findIcon.mockResolvedValueOnce(png);
    expect(await usageIcon(H, 'alex', 'com.google.android.youtube')).toBe(png);
    expect(limits.isLimitedFor).toHaveBeenCalledWith(['jo'], 'com.google.android.youtube');
  });

  it('gives a child the icons of apps in their own usage', async () => {
    const png = new Uint8Array([4]);
    usage.usageNamesApp.mockResolvedValueOnce(true);
    usage.findIcon.mockResolvedValueOnce(png);
    // Sam supervises nobody: only their own days are searched.
    expect(await usageIcon(H, 'sam', 'com.roblox.client')).toBe(png);
    expect(usage.usageNamesApp).toHaveBeenCalledWith(['sam'], 'com.roblox.client');
  });

  it('gives a supervisor a shared child’s whole history, without logging it', async () => {
    const history = { days: [{ day: '2026-10-12', totalMinutes: 5, apps: [], updatedAt: 'x' }] };
    findLinks.mockResolvedValueOnce(sharing(sam, true));
    usage.usageHistory.mockResolvedValueOnce(history);
    expect(await supervisedUsageHistory(H, { id: 'alex' }, 'sam')).toBe(history);
    expect(usage.usageHistory).toHaveBeenCalledWith(H, 'sam');
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('refuses the history to anyone who does not supervise them, and while it isn’t shared', async () => {
    await expect(supervisedUsageHistory(H, { id: 'jordan' }, 'sam')).rejects.toThrow(/Only an adult who supervises/);
    findLinks.mockResolvedValueOnce(sharing(sam, null));
    await expect(supervisedUsageHistory(H, { id: 'alex' }, 'sam')).rejects.toThrow(/Sam’s app usage isn’t shared/);
    expect(usage.usageHistory).not.toHaveBeenCalled();
  });
});
