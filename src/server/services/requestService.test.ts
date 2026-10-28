import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_MODULES, type RequestModuleSettings } from '@/lib/requestModules';

const prisma = {
  request: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    // The saved row: the request as it was, with the change.
    update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => ({ ...ROW, ...args.data })),
    delete: vi.fn(),
  },
  user: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findUnique: vi.fn(async (): Promise<unknown> => ({ name: 'Sam' })),
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

const { deleteRequest, reassignRequest } = await import('./requestService');

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
