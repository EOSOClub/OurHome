import { beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing here may reach a real database.
vi.mock('@/server/db/prisma', () => ({ prisma: {} }));
const supervisorsOf = vi.fn(async (): Promise<string[]> => []);
vi.mock('@/server/services/pointsTimeService', () => ({ supervisorsOf }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));

const {
  askSupervisors,
  healAwaitingReview,
  isSupervisedChild,
  mayUndoCheck,
  needsCheck,
  supervisedNow,
  supervisesNow,
  tellChild,
  wakeForChecks,
  withdrawInTx,
} = await import('@/server/services/taskReviewService');

const tx = {
  user: { findFirst: vi.fn() },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  taskSubmission: { findFirst: vi.fn(async (): Promise<unknown> => null), update: vi.fn() },
  task: { update: vi.fn(), updateMany: vi.fn() },
  taskPhoto: { deleteMany: vi.fn() },
  notification: { create: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
};
const H = 'household1';

beforeEach(() => {
  vi.clearAllMocks();
  tx.supervision.findMany.mockResolvedValue([]);
  tx.taskSubmission.findFirst.mockResolvedValue(null);
});

describe('needsCheck', () => {
  /** The answer for someone with [role] and [reviewTasks], supervised by [supervisors]. */
  async function check(opts: {
    role: string;
    reviewTasks?: boolean | null;
    photoProof?: boolean | null;
    supervisors?: string[];
  }) {
    tx.user.findFirst.mockResolvedValueOnce({ role: opts.role, reviewTasks: opts.reviewTasks ?? null });
    // Not "once": it is never read when the answer is already no.
    tx.supervision.findMany.mockResolvedValue((opts.supervisors ?? []).map((role) => ({ supervisor: { role } })));
    return needsCheck(tx as never, H, 'kid', { photoProof: opts.photoProof ?? null });
  }

  it('checks a supervised child or teen whose supervisor turned checks on', async () => {
    expect(await check({ role: 'child', reviewTasks: true, supervisors: ['adult'] })).toBe(true);
    expect(await check({ role: 'teen', reviewTasks: true, supervisors: ['head'] })).toBe(true);
    expect(tx.user.findFirst).toHaveBeenCalledWith({ where: { id: 'kid', householdId: H }, select: { role: true, reviewTasks: true } });
    expect(tx.supervision.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: H, supervisedId: 'kid' } }));
  });

  it('checks a supervised child or teen on a task that asks for a photo, even with checks off', async () => {
    expect(await check({ role: 'child', photoProof: true, supervisors: ['manager'] })).toBe(true);
    expect(await check({ role: 'teen', reviewTasks: false, photoProof: true, supervisors: ['adult'] })).toBe(true);
  });

  it('never checks without a reason: checks off and no photo asked', async () => {
    expect(await check({ role: 'child', supervisors: ['adult'] })).toBe(false);
    expect(await check({ role: 'child', reviewTasks: false, photoProof: false, supervisors: ['adult'] })).toBe(false);
  });

  it('never checks someone nobody supervises right now', async () => {
    expect(await check({ role: 'child', reviewTasks: true, photoProof: true, supervisors: [] })).toBe(false);
    // Their only supervisor is no longer an adult.
    expect(await check({ role: 'child', reviewTasks: true, supervisors: ['teen'] })).toBe(false);
    expect(await check({ role: 'teen', photoProof: true, supervisors: ['guest', 'child'] })).toBe(false);
    // One current supervisor among old links is enough.
    expect(await check({ role: 'teen', photoProof: true, supervisors: ['guest', 'adult'] })).toBe(true);
  });

  it('never checks adults, the head or guests, whatever the task or their old setting', async () => {
    for (const role of ['head', 'manager', 'adult', 'guest']) {
      expect(await check({ role, reviewTasks: true, photoProof: true, supervisors: ['head'] })).toBe(false);
    }
    // Nothing more is read for them.
    expect(tx.supervision.findMany).not.toHaveBeenCalled();
  });

  it('never checks someone outside the household', async () => {
    tx.user.findFirst.mockResolvedValueOnce(null);
    expect(await needsCheck(tx as never, H, 'stranger', { photoProof: true })).toBe(false);
  });
});

describe('healAwaitingReview', () => {
  it('leaves every other task alone, without reading anything', async () => {
    for (const status of ['pending', 'in_progress', 'completed', 'archived']) {
      const task = { id: 't1', status };
      expect(await healAwaitingReview(tx as never, H, task)).toBe(task);
    }
    expect(tx.taskSubmission.findFirst).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it('leaves a task that really is waiting for its check', async () => {
    tx.taskSubmission.findFirst.mockResolvedValueOnce({ id: 's1' });
    const task = { id: 't1', status: 'awaiting_review', title: 'Dishes' };
    expect(await healAwaitingReview(tx as never, H, task)).toBe(task);
    expect(tx.taskSubmission.findFirst).toHaveBeenCalledWith({
      where: { householdId: H, taskId: 't1', kind: 'task', status: 'waiting' },
      select: { id: true },
    });
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it('opens a task waiting with nothing to wait for, writes it back and says so in one line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const healed = await healAwaitingReview(tx as never, H, { id: 't1', status: 'awaiting_review', title: 'Dishes' });
    expect(healed).toEqual({ id: 't1', status: 'pending', title: 'Dishes' });
    expect(tx.task.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'pending' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('t1');
    expect(String(warn.mock.calls[0][0])).not.toContain('Dishes');
    warn.mockRestore();
  });
});

describe('who may undo an approved check (mayUndoCheck)', () => {
  const NOW = new Date('2026-10-29T15:00:00.000Z');
  const WINDOW = 10 * 60_000;
  const approved = { status: 'approved', decidedById: 'mum', decidedAt: new Date(NOW.getTime() - 5 * 60_000) };
  const mum = { id: 'mum', role: 'adult' };

  it('the adult who approved it, within the window, while they still look after the child', () => {
    expect(mayUndoCheck(approved, mum, NOW, true, WINDOW)).toBe(true);
    expect(mayUndoCheck(approved, mum, NOW, false, WINDOW)).toBe(false);
    expect(mayUndoCheck({ ...approved, decidedAt: new Date(NOW.getTime() - WINDOW - 1) }, mum, NOW, true, WINDOW)).toBe(false);
  });

  it('the head any time; nobody else, the child included', () => {
    expect(mayUndoCheck({ ...approved, decidedAt: new Date(0) }, { id: 'boss', role: 'head' }, NOW, false, WINDOW)).toBe(true);
    expect(mayUndoCheck(approved, { id: 'dad', role: 'adult' }, NOW, true, WINDOW)).toBe(false);
    expect(mayUndoCheck(approved, { id: 'kid', role: 'child' }, NOW, false, WINDOW)).toBe(false);
    // Gone since: only the head.
    expect(mayUndoCheck(null, mum, NOW, true, WINDOW)).toBe(false);
    expect(mayUndoCheck(null, { id: 'boss', role: 'head' }, NOW, false, WINDOW)).toBe(true);
  });

  it('never one counted as done on its own', () => {
    const auto = { status: 'auto_approved', decidedById: null, decidedAt: NOW };
    expect(mayUndoCheck(auto, { id: 'boss', role: 'head' }, NOW, true, WINDOW)).toBe(false);
  });
});

describe('who looks after whom, for checks', () => {
  it('reads the current supervisors in the transaction', async () => {
    supervisorsOf.mockResolvedValueOnce(['mum', 'dad']);
    expect(await supervisesNow(tx as never, H, 'dad', 'kid')).toBe(true);
    expect(supervisorsOf).toHaveBeenCalledWith(tx, H, 'kid');
    supervisorsOf.mockResolvedValueOnce(['mum']);
    expect(await supervisesNow(tx as never, H, 'dad', 'kid')).toBe(false);
  });

  it('lists the children someone looks after while both roles fit', async () => {
    tx.supervision.findMany.mockResolvedValueOnce([
      { supervisedId: 'kid', supervisor: { role: 'adult' }, supervised: { role: 'child' } },
      { supervisedId: 'grown', supervisor: { role: 'adult' }, supervised: { role: 'adult' } },
    ]);
    expect(await supervisedNow(tx as never, H, 'mum')).toEqual(new Set(['kid']));
  });

  it('a supervised child or teen is one with a current supervisor', async () => {
    tx.user.findFirst.mockResolvedValueOnce({ role: 'teen' });
    supervisorsOf.mockResolvedValueOnce(['mum']);
    expect(await isSupervisedChild(tx as never, H, 'kid')).toBe(true);
    tx.user.findFirst.mockResolvedValueOnce({ role: 'teen' });
    supervisorsOf.mockResolvedValueOnce([]);
    expect(await isSupervisedChild(tx as never, H, 'kid')).toBe(false);
    tx.user.findFirst.mockResolvedValueOnce({ role: 'adult' });
    expect(await isSupervisedChild(tx as never, H, 'mum')).toBe(false);
  });
});

describe('check bells', () => {
  it('one row per supervisor, replacing the old ones; none when nobody looks after the child', async () => {
    await askSupervisors(tx as never, H, { id: 's1', taskId: 't1' }, 'Riley', 'Dishes', ['mum']);
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({
      where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s1:' } },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: 'mum', title: 'Riley sent “Dishes” for a check', body: null, dedupeKey: 'task_review:s1:mum' })],
    });
    vi.clearAllMocks();
    await askSupervisors(tx as never, H, { id: 's1', taskId: 't1' }, 'Riley', 'Dishes', []);
    expect(tx.notification.deleteMany).toHaveBeenCalled();
    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });

  it('the child has one answer per check, replaced by a newer one', async () => {
    await tellChild(tx as never, H, { id: 's1', taskId: 't1', userId: 'kid' }, 'Sent back: Dishes', 'Again');
    expect(tx.notification.deleteMany).toHaveBeenCalledWith({ where: { householdId: H, type: 'task_reviewed', dedupeKey: 'task_reviewed:s1' } });
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'kid', type: 'task_reviewed', title: 'Sent back: Dishes', body: 'Again', subjectType: 'task', subjectId: 't1' }),
    });
  });

  it('wakes each phone once, and nobody when there is nobody', () => {
    wakeForChecks(H, ['mum', 'kid', 'mum', null]);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'kid'] }, 'task');
    pushSync.mockClear();
    wakeForChecks(H, []);
    expect(pushSync).not.toHaveBeenCalled();
  });
});

describe('withdrawInTx', () => {
  const NOW = new Date('2026-10-29T15:00:00.000Z');

  it('ends the check unpaid, deletes the photo, removes the rows, and puts a waiting task back', async () => {
    await withdrawInTx(tx as never, H, { id: 's1', taskId: 't1', userId: 'kid', kind: 'task', prevStatus: 'pending' }, NOW);
    expect(tx.taskSubmission.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { status: 'withdrawn', decidedAt: NOW, waitingKey: 's1' } });
    expect(tx.taskPhoto.deleteMany).toHaveBeenCalledWith({ where: { submissionId: 's1' } });
    expect(tx.task.updateMany).toHaveBeenCalledWith({ where: { id: 't1', status: 'awaiting_review' }, data: { status: 'pending' } });
  });

  it('never touches the task for a steps check', async () => {
    await withdrawInTx(tx as never, H, { id: 's2', taskId: 't1', userId: 'kid', kind: 'steps', prevStatus: null }, NOW);
    expect(tx.task.updateMany).not.toHaveBeenCalled();
  });
});
