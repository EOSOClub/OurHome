import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_MODULES, type RequestModuleSettings } from '@/lib/requestModules';

const prisma = {
  request: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    // The saved row: the request as it was, with the change.
    update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => ({ ...ROW, ...args.data })),
    delete: vi.fn(),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirstOrThrow: vi.fn(async (): Promise<unknown> => ({ ...ROW })),
  },
  requestNote: {
    create: vi.fn(),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    delete: vi.fn(),
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
const notices = {
  announceRequestAnswer: vi.fn(),
  clearRequestNotice: vi.fn(),
  announceRequestNote: vi.fn(),
  clearNoteNotices: vi.fn(),
  clearRequestNoteNotices: vi.fn(),
};
vi.mock('@/server/services/requestNoticeService', () => notices);
const modules = {
  getRequestModules: vi.fn(async (): Promise<RequestModuleSettings> => DEFAULT_REQUEST_MODULES),
  householdMemberIds: vi.fn(async () => ['head', 'sam', 'tester', 'alex']),
  supervisorsByMember: vi.fn(async () => new Map<string, string[]>()),
};
vi.mock('@/server/services/requestModuleService', () => modules);
const permissions = { getUserAccess: vi.fn(), membersWithAccess: vi.fn(async (): Promise<string[]> => []) };
vi.mock('@/server/services/permissionService', () => permissions);
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn() }));
vi.mock('@/server/services/shoppingService', () => ({ addShoppingItem: vi.fn() }));
vi.mock('@/server/services/serverAdminService', () => ({ isFeatureEnabled: vi.fn() }));

const {
  acceptRequest,
  addRequestNote,
  completeRequest,
  countNewRequests,
  deleteRequest,
  deleteRequestNote,
  markRequestsSeen,
  reassignRequest,
} = await import('./requestService');

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

describe('media is accepted, then marked added', () => {
  const MEDIA = { ...ROW, category: 'media', title: 'Dune', mediaType: 'movie', year: 2021, assigneeId: null, status: 'pending' };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.request.findFirst.mockResolvedValue({ ...MEDIA });
    prisma.request.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ ...MEDIA, ...args.data }));
    permissions.getUserAccess.mockResolvedValue({ requests: { approve: true } });
    modules.getRequestModules.mockResolvedValue(DEFAULT_REQUEST_MODULES);
  });

  it('accepting records who took it on and tells the requester', async () => {
    await acceptRequest(H, HEAD, { id: ID });
    expect(savedData()).toEqual({
      status: 'accepted',
      acceptedAt: expect.any(Date),
      decidedBy: { connect: { id: 'head' } },
      changedById: 'head',
    });
    expect(notices.announceRequestAnswer).toHaveBeenCalledWith(
      prisma,
      H,
      expect.objectContaining({ status: 'accepted' }),
      'accepted',
      expect.objectContaining({ id: 'head' }),
      expect.anything(),
    );
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'accepted the movie “Dune (2021)”' }),
    );
  });

  it('not twice, and not by someone who does not handle media', async () => {
    prisma.request.findFirst.mockResolvedValueOnce({ ...MEDIA, status: 'accepted' });
    await expect(acceptRequest(H, HEAD, { id: ID })).rejects.toThrow('already accepted');
    permissions.getUserAccess.mockResolvedValue({ requests: { approve: false } });
    await expect(acceptRequest(H, ADULT, { id: ID })).rejects.toThrow('accept or add media');
    expect(prisma.request.update).not.toHaveBeenCalled();
  });

  it('marking an accepted one added completes it', async () => {
    prisma.request.findFirst.mockResolvedValueOnce({ ...MEDIA, status: 'accepted' });
    await completeRequest(H, HEAD, { id: ID });
    expect(savedData()).toEqual(expect.objectContaining({ status: 'completed', decidedBy: { connect: { id: 'head' } } }));
    expect(activity.logActivity).toHaveBeenCalledWith(expect.objectContaining({ message: 'added the movie “Dune (2021)”' }));
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
    expect(notices.clearRequestNoteNotices).toHaveBeenCalledWith(prisma, H, ID);
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

describe('notes on a request', () => {
  const NOTE = { id: 'note1', householdId: H, requestId: ID, authorId: 'alex', body: 'Try the shutoff valve first' };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.request.findFirst.mockResolvedValue({ ...ROW });
    prisma.requestNote.findFirst.mockResolvedValue({ ...NOTE });
    prisma.request.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...ROW,
      decidedById: null,
      notes: [{ id: 'note1', author: { id: 'alex', name: 'Alex' } }],
      ...args.data,
    }));
    prisma.requestNote.create.mockResolvedValue({ ...NOTE });
    permissions.membersWithAccess.mockResolvedValue(['head']);
    modules.getRequestModules.mockResolvedValue(DEFAULT_REQUEST_MODULES);
  });

  /** Who the last note told. */
  const told = () => notices.announceRequestNote.mock.calls[0][5];

  it('tells the requester and the person asked, by name, never the author', async () => {
    await addRequestNote(H, ADULT, { id: ID, body: 'Try the shutoff valve first' });
    expect(notices.announceRequestNote).toHaveBeenCalledWith(
      prisma,
      H,
      expect.objectContaining({ id: ID }),
      expect.objectContaining({ id: 'note1' }),
      { id: 'alex', name: 'Alex' },
      ['sam', 'tester'],
    );
    vi.clearAllMocks();
    await addRequestNote(H, { id: 'sam', role: 'adult' }, { id: ID, body: 'It drips at night' });
    expect(told()).toEqual(['tester']);
  });

  it('media nobody has taken on yet: everyone who handles it; once taken on, whoever did', async () => {
    const MEDIA = { ...ROW, category: 'media', title: 'Dune', mediaType: 'movie', year: 2021, assigneeId: null, status: 'pending' };
    prisma.request.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...MEDIA,
      decidedById: null,
      notes: [],
      ...args.data,
    }));
    await addRequestNote(H, ADULT, { id: ID, body: 'The 4K one, please' });
    expect(told()).toEqual(['sam', 'head']);

    vi.clearAllMocks();
    prisma.request.update.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      ...MEDIA,
      status: 'accepted',
      decidedById: 'tester',
      notes: [],
      ...args.data,
    }));
    await addRequestNote(H, ADULT, { id: ID, body: 'The 4K one, please' });
    expect(told()).toEqual(['sam', 'tester']);
    expect(permissions.membersWithAccess).not.toHaveBeenCalled();
  });

  it('a failed notice still saves the note', async () => {
    notices.announceRequestNote.mockRejectedValueOnce(new Error('down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(addRequestNote(H, ADULT, { id: ID, body: 'Hi' })).resolves.toEqual(expect.objectContaining({ id: ID }));
    expect(prisma.requestNote.create).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('anyone adds one, even to a finished request, and it counts as a change', async () => {
    prisma.request.findFirst.mockResolvedValueOnce({ ...ROW, status: 'completed' });
    await addRequestNote(H, ADULT, { id: ID, body: 'Try the shutoff valve first' });
    expect(prisma.requestNote.create).toHaveBeenCalledWith({
      data: { householdId: H, requestId: ID, authorId: 'alex', body: 'Try the shutoff valve first' },
    });
    expect(savedData()).toEqual({ changedById: 'alex' });
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'alex', message: 'added a note to “Fix the faucet”' }),
    );
  });

  it('not on a kind that is turned off', async () => {
    modules.getRequestModules.mockResolvedValue({
      ...DEFAULT_REQUEST_MODULES,
      maintenance: { ...DEFAULT_REQUEST_MODULES.maintenance, enabled: false },
    });
    await expect(addRequestNote(H, ADULT, { id: ID, body: 'Hi' })).rejects.toThrow('turned off');
    expect(prisma.requestNote.create).not.toHaveBeenCalled();
  });

  it('its author removes it, and so may the head, without it counting as a change', async () => {
    await deleteRequestNote(H, ADULT, 'note1');
    await deleteRequestNote(H, HEAD, 'note1');
    expect(prisma.requestNote.delete).toHaveBeenCalledTimes(2);
    expect(prisma.requestNote.delete).toHaveBeenCalledWith({ where: { id: 'note1' } });
    expect(notices.clearNoteNotices).toHaveBeenCalledWith(prisma, H, 'note1');
    expect(prisma.request.update).not.toHaveBeenCalled();
  });

  it('nobody else removes it, and only in their own household', async () => {
    await expect(deleteRequestNote(H, { id: 'sam', role: 'adult' }, 'note1')).rejects.toThrow('your own notes');
    prisma.requestNote.findFirst.mockResolvedValueOnce(null);
    await expect(deleteRequestNote(H, HEAD, 'other')).rejects.toThrow('Note not found');
    expect(prisma.requestNote.findFirst).toHaveBeenLastCalledWith({ where: { id: 'other', householdId: H } });
    expect(prisma.requestNote.delete).not.toHaveBeenCalled();
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
