import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_MODULES, type RequestModuleSettings } from '@/lib/requestModules';

const prisma = {
  request: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    // The saved row: the request as it was, with the change.
    update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => ({ ...ROW, ...args.data })),
    delete: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  user: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findUnique: vi.fn(async (): Promise<unknown> => ({ name: 'Sam' })),
    update: vi.fn(),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const activity = { logActivity: vi.fn() };
vi.mock('@/server/services/activityService', () => activity);
vi.mock('@/server/services/pushService', () => ({ pushSync: vi.fn() }));
const notices = { announceRequestAnswer: vi.fn(), clearRequestNotice: vi.fn() };
vi.mock('@/server/services/requestNoticeService', () => notices);
const modules = {
  getRequestModules: vi.fn(async (): Promise<RequestModuleSettings> => DEFAULT_REQUEST_MODULES),
  householdMemberIds: vi.fn(async () => ['head', 'sam', 'tester', 'alex']),
  supervisorsByMember: vi.fn(async () => new Map<string, string[]>()),
};
vi.mock('@/server/services/requestModuleService', () => modules);
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn() }));
vi.mock('@/server/services/shoppingService', () => ({ addShoppingItem: vi.fn() }));
vi.mock('@/server/services/serverAdminService', () => ({ isFeatureEnabled: vi.fn() }));

const { countNewRequests, deleteRequest, markRequestsSeen, reassignRequest } = await import('./requestService');

const H = 'h1';
const HEAD = { id: 'head', role: 'head' };
const ADULT = { id: 'alex', role: 'adult' };
const ID = 'req1';
const ROW = {
  id: ID,
  householdId: H,
  category: 'maintenance',
  title: 'Fix the faucet',
  mediaType: null,
  year: null,
  issue: null,
  requesterId: 'sam',
  assigneeId: 'tester',
  status: 'accepted',
};
const named = { tester: 'Small Test', alex: 'Alex', sam: 'Sam', head: 'Pat' } as Record<string, string>;
const savedData = () => prisma.request.update.mock.calls[0][0].data;

describe('the head reassigns a maintenance request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.request.findFirst.mockResolvedValue({ ...ROW });
    prisma.user.findFirst.mockImplementation(async (args?: unknown) => {
      const id = (args as { where: { id: string } }).where.id;
      return named[id] ? { id, name: named[id] } : null;
    });
    modules.getRequestModules.mockResolvedValue(DEFAULT_REQUEST_MODULES);
  });

  it('sends it to the new person, back to waiting, and drops the old acceptance', async () => {
    await reassignRequest(H, HEAD, { id: ID, assigneeId: 'alex' });
    expect(savedData()).toEqual({
      assignee: { connect: { id: 'alex' } },
      status: 'pending',
      dueAt: null,
      acceptedAt: null,
      completedAt: null,
      changedById: 'head',
    });
    expect(notices.clearRequestNotice).toHaveBeenCalledWith(prisma, H, ID);
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'head', message: 'gave “Fix the faucet” to Alex' }),
    );
  });

  it('may pick someone outside the who-may-be-asked list, even themselves', async () => {
    modules.getRequestModules.mockResolvedValue({
      ...DEFAULT_REQUEST_MODULES,
      maintenance: { ...DEFAULT_REQUEST_MODULES.maintenance, assigneeIds: ['tester'] },
    });
    await reassignRequest(H, HEAD, { id: ID, assigneeId: 'head' });
    expect(savedData().assignee).toEqual({ connect: { id: 'head' } });
  });

  it('refuses everyone but the head', async () => {
    await expect(reassignRequest(H, ADULT, { id: ID, assigneeId: 'head' })).rejects.toThrow(
      'Only the Head of House can reassign requests.',
    );
    expect(prisma.request.update).not.toHaveBeenCalled();
  });

  it('never to the requester, nor to who has it already', async () => {
    await expect(reassignRequest(H, HEAD, { id: ID, assigneeId: 'sam' })).rejects.toThrow('Choose someone else');
    await expect(reassignRequest(H, HEAD, { id: ID, assigneeId: 'tester' })).rejects.toThrow('already with them');
    expect(prisma.request.update).not.toHaveBeenCalled();
  });

  it('not once it is done or declined, and only maintenance', async () => {
    prisma.request.findFirst.mockResolvedValueOnce({ ...ROW, status: 'completed' });
    await expect(reassignRequest(H, HEAD, { id: ID, assigneeId: 'alex' })).rejects.toThrow('already done');
    prisma.request.findFirst.mockResolvedValueOnce({ ...ROW, category: 'purchase' });
    await expect(reassignRequest(H, HEAD, { id: ID, assigneeId: 'alex' })).rejects.toThrow('Only maintenance');
    expect(prisma.request.update).not.toHaveBeenCalled();
  });
});

describe('removing a request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.request.findFirst.mockResolvedValue({ ...ROW });
  });

  it('the head may remove someone else’s maintenance request', async () => {
    await deleteRequest(H, HEAD, ID);
    expect(prisma.request.delete).toHaveBeenCalledWith({ where: { id: ID } });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'head', message: 'removed Sam’s request “Fix the faucet”' }),
    );
  });

  it('the requester still withdraws their own', async () => {
    await deleteRequest(H, { id: 'sam', role: 'adult' }, ID);
    expect(prisma.request.delete).toHaveBeenCalled();
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'withdrew their request “Fix the faucet”' }),
    );
  });

  it('nobody else, and not the head on other kinds', async () => {
    await expect(deleteRequest(H, ADULT, ID)).rejects.toThrow('your own requests');
    prisma.request.findFirst.mockResolvedValueOnce({ ...ROW, category: 'purchase' });
    await expect(deleteRequest(H, HEAD, ID)).rejects.toThrow('your own requests');
    expect(prisma.request.delete).not.toHaveBeenCalled();
  });
});

// The Requests badge counts what someone else did since they last opened
// Requests, not what is still waiting on them.
describe('the Requests badge', () => {
  const MEDIA_AND_MAINTENANCE: RequestModuleSettings = {
    ...DEFAULT_REQUEST_MODULES,
    media: { ...DEFAULT_REQUEST_MODULES.media, enabled: true },
    maintenance: { ...DEFAULT_REQUEST_MODULES.maintenance, enabled: true },
    purchase: { ...DEFAULT_REQUEST_MODULES.purchase, enabled: false },
    permission: { ...DEFAULT_REQUEST_MODULES.permission, enabled: false },
  };
  const SEEN = new Date('2026-10-29T12:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
    modules.getRequestModules.mockResolvedValue(MEDIA_AND_MAINTENANCE);
  });

  it('counts only changes by someone else, of kinds that are on, after their last visit', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ requestsSeenAt: SEEN });
    prisma.request.findMany.mockResolvedValueOnce([
      { category: 'media', changedById: 'sam' },
      { category: 'maintenance', changedById: 'head' },
      // Their own change.
      { category: 'media', changedById: 'alex' },
      // Untouched since the badge was added.
      { category: 'media', changedById: null },
      // A kind that is off.
      { category: 'purchase', changedById: 'sam' },
    ]);
    await expect(countNewRequests(H, 'alex')).resolves.toBe(2);
    expect(prisma.request.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: H, updatedAt: { gt: SEEN } } }),
    );
  });

  it('never opened: counts every changed row, still leaving out untouched ones', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ requestsSeenAt: null });
    prisma.request.findMany.mockResolvedValueOnce([
      { category: 'media', changedById: 'sam' },
      { category: 'media', changedById: null },
    ]);
    await expect(countNewRequests(H, 'alex')).resolves.toBe(1);
    expect(prisma.request.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: H } }));
  });

  it('every kind off: nothing, without asking for rows', async () => {
    modules.getRequestModules.mockResolvedValueOnce({
      ...MEDIA_AND_MAINTENANCE,
      media: { ...MEDIA_AND_MAINTENANCE.media, enabled: false },
      maintenance: { ...MEDIA_AND_MAINTENANCE.maintenance, enabled: false },
    });
    prisma.user.findUnique.mockResolvedValueOnce({ requestsSeenAt: SEEN });
    await expect(countNewRequests(H, 'alex')).resolves.toBe(0);
    expect(prisma.request.findMany).not.toHaveBeenCalled();
  });

  it('opening Requests starts the count over', async () => {
    await markRequestsSeen('alex', SEEN);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'alex' }, data: { requestsSeenAt: SEEN } });
  });

  it('every change records who made it', async () => {
    prisma.request.findFirst.mockResolvedValueOnce({ ...ROW, status: 'pending' });
    prisma.user.findFirst.mockResolvedValueOnce({ id: 'alex', name: 'Alex' });
    await reassignRequest(H, HEAD, { id: ID, assigneeId: 'alex' });
    expect(savedData()).toMatchObject({ changedById: 'head' });
  });
});
