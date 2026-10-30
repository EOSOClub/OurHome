import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deciding, taking back, settling and reading task checks (Task Photo
// Proof), against a recording stand-in for Prisma with the real taskService
// underneath, so an approval's rows can be compared with a completion's.

type Call = [string, unknown];
const writes: Call[] = [];
function writer(name: string, answer: (arg: never) => unknown = () => ({ count: 1 })) {
  return vi.fn(async (arg: never) => {
    writes.push([name, arg]);
    return answer(arg);
  });
}
const written = (name: string) => writes.filter(([n]) => n === name).map(([, arg]) => arg as { where?: unknown; data: Record<string, unknown> });
const names = () => writes.map(([n]) => n);

let stored: Record<string, unknown> = {};
const tx = {
  task: {
    findFirst: vi.fn(async (): Promise<unknown> => stored),
    update: writer('task.update', (arg: { data: Record<string, unknown> }) => ({ ...stored, ...arg.data })),
    updateMany: writer('task.updateMany'),
  },
  taskCompletion: {
    create: writer('taskCompletion.create', (arg: { data: Record<string, unknown> }) => ({ id: 'done1', ...arg.data })),
  },
  taskSubmission: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    update: writer('taskSubmission.update'),
    count: vi.fn(async () => 0),
  },
  taskPhoto: { deleteMany: writer('taskPhoto.deleteMany') },
  notification: {
    create: writer('notification.create'),
    createMany: writer('notification.createMany'),
    deleteMany: writer('notification.deleteMany'),
  },
  pendingCredit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    deleteMany: writer('pendingCredit.deleteMany'),
  },
  pointAward: {
    createMany: writer('pointAward.createMany'),
    updateMany: writer('pointAward.updateMany'),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  subtask: { update: writer('subtask.update'), updateMany: writer('subtask.updateMany') },
  recurrenceRule: { update: writer('recurrenceRule.update') },
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => null),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
const prisma = {
  task: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    update: writer('prisma.task.update'),
  },
  household: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 })) },
  taskSubmission: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    count: vi.fn(async () => 0),
  },
  taskPhoto: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    deleteMany: writer('prisma.taskPhoto.deleteMany', () => ({ count: 1 })),
  },
  taskCompletion: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  pointAward: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  user: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn(async (entry: unknown) => {
  writes.push(['logActivity', entry]);
});
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const ready = {
  announceTaskReady: vi.fn(async (): Promise<string | null> => null),
  clearTaskReady: vi.fn(async (_tx: unknown, _hh: string, taskId: string) => {
    writes.push(['clearTaskReady', taskId]);
  }),
  pushTaskReady: vi.fn(),
};
vi.mock('@/server/services/taskReadyService', () => ready);
const supervisorsOf = vi.fn(async (): Promise<string[]> => []);
vi.mock('@/server/services/pointsTimeService', () => ({ supervisorsOf }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));

const {
  countTasksToCheck,
  decideSubmission,
  deleteExpiredPhotos,
  listSubmissions,
  settleOrphanedSubmissions,
  submissionPhoto,
  withdrawSubmission,
} = await import('./taskSubmissionService');
const { completeTask } = await import('./taskService');
const { Prisma } = await import('@prisma/client');

const H = 'household1';
const NOW = new Date('2026-10-29T15:00:00.000Z');
const SENT = new Date('2026-10-29T13:00:00.000Z');
const QUEUED_AT = new Date('2026-10-29T12:00:00.000Z');
const DAY = 86_400_000;
const mum = { id: 'mum', role: 'adult' };
const kid = { id: 'kid', role: 'child' };
const KID_ROW = { id: 'kid', role: 'child', reviewTasks: true, name: 'Riley' };

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  taskId: 't1',
  title: `Step ${id}`,
  done: false,
  doneAt: null,
  doneById: null,
  checkAwardId: null,
  autoResetAt: null,
  resetIntervalDays: null,
  minutes: 10,
  pointsCenti: 100,
  minutesCustom: false,
  pointsFollowTime: true,
  position: 0,
  ...over,
});
function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    householdId: H,
    title: 'Dishes',
    status: 'in_progress',
    dueDate: new Date('2026-10-29T17:00:00.000Z'),
    completedAt: null,
    estimatedMinutes: 20,
    pointsCenti: 200,
    baseMinutes: 20,
    basePointsCenti: 200,
    pointsFollowTime: true,
    cycleStartedAt: null,
    cycleEndsAt: null,
    opensAt: null,
    assigneeId: 'kid',
    rotationUserIds: null,
    recurrence: null,
    photoProof: null,
    subtasks: [step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }), step('b', { position: 1 })],
    ...over,
  };
}
function check(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    householdId: H,
    taskId: 't1',
    userId: 'kid',
    kind: 'task',
    status: 'waiting',
    autoReason: null,
    prevStatus: 'in_progress',
    submittedAt: SENT,
    cycleEndsAt: null,
    stepIds: ['a'],
    note: 'All done',
    entries: null,
    decidedById: null,
    decidedAt: null,
    completionId: null,
    takenBackAt: null,
    ...over,
  };
}
const queuedA = { id: 'pc1', householdId: H, taskId: 't1', subtaskId: 'a', userId: 'kid', checkedAt: QUEUED_AT, cycleStartedAt: null };

/** A check the kid sent; Mum and Dad look after the kid. */
function setUp(c: Record<string, unknown> = check(), opts: { taskRows?: unknown[] } = {}) {
  prisma.taskSubmission.findFirst.mockResolvedValue({ taskId: 't1', status: (c as { status: string }).status });
  tx.taskSubmission.findFirst.mockResolvedValue(c);
  tx.user.findFirst.mockResolvedValue(KID_ROW);
  supervisorsOf.mockResolvedValue(['mum', 'dad']);
  for (const row of opts.taskRows ?? [task({ status: 'awaiting_review' }), task()]) tx.task.findFirst.mockResolvedValueOnce(row);
}

beforeEach(() => {
  vi.resetAllMocks();
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  stored = task();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('decideSubmission: approve', () => {
  it('equals completing it by hand when it was sent, with the points landing now', async () => {
    // Completed by hand at the moment it was sent, by the same child.
    vi.setSystemTime(SENT);
    tx.user.findFirst.mockResolvedValue({ ...KID_ROW, reviewTasks: null });
    tx.pendingCredit.findMany.mockResolvedValueOnce([queuedA]);
    await completeTask(H, kid, { taskId: 't1' });
    const byHand = writes.slice(writes.findIndex(([n]) => n === 'taskCompletion.create'));
    writes.length = 0;

    vi.setSystemTime(NOW);
    setUp();
    tx.pendingCredit.findMany.mockResolvedValueOnce([queuedA]);
    tx.pointAward.findMany.mockResolvedValueOnce([{ pointsCenti: 100 }, { pointsCenti: 100 }]);
    const out = await decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' });
    expect(out).toEqual({ taskId: 't1', completionId: 'done1' });

    const start = writes.findIndex(([n]) => n === 'taskCompletion.create');
    const approved = writes.slice(start, start + byHand.length);
    // Identical rows, apart from when they were written and the check they pay.
    const asWritten = JSON.parse(
      JSON.stringify(byHand).replaceAll(`"recordedAt":"${SENT.toISOString()}"`, `"recordedAt":"${NOW.toISOString()}","submissionId":"s1"`)
        .replaceAll(`"awardedAt":"${SENT.toISOString()}"`, `"awardedAt":"${NOW.toISOString()}"`),
    );
    expect(JSON.parse(JSON.stringify(approved))).toEqual(asWritten);
    // Before it: the task back as it was when sent.
    expect(writes[start - 1]).toEqual(['task.update', { where: { id: 't1' }, data: { status: 'in_progress' } }]);
  });

  it('records the decision, answers the child, clears every supervisor’s row, logs it without the note', async () => {
    setUp();
    tx.pointAward.findMany.mockResolvedValueOnce([{ pointsCenti: 500 }]);
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' });
    expect(written('taskSubmission.update')[0]).toEqual({
      where: { id: 's1' },
      data: {
        status: 'approved',
        decidedById: 'mum',
        decidedAt: NOW,
        completionId: 'done1',
        photoDeleteAt: new Date(NOW.getTime() + 14 * DAY),
      },
    });
    // Only the child's own points count in their answer.
    expect(tx.pointAward.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ completionId: 'done1', userId: 'kid' }) }),
    );
    expect(written('notification.deleteMany')).toContainEqual({
      where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s1:' } },
    });
    expect(written('notification.create')[0].data).toMatchObject({
      userId: 'kid',
      type: 'task_reviewed',
      title: 'Approved: Dishes (+5 pts)',
      body: null,
      subjectType: 'task',
      subjectId: 't1',
    });
    const activity = writes.filter(([n]) => n === 'logActivity').map(([, a]) => a as { actorId: string; message: string; metadata?: unknown });
    // The completion keeps the child as who did it; the approval is the adult's.
    expect(activity.map((a) => [a.actorId, a.message])).toEqual([
      ['kid', 'completed task “Dishes” (2 pts)'],
      ['mum', 'approved Riley’s “Dishes”'],
    ]);
    expect(JSON.stringify(activity)).not.toContain('All done');
    // Rolled over afterwards (it counts as of when it was sent), and the phones woken.
    expect(prisma.task.findMany).toHaveBeenCalledTimes(2);
    expect(ready.pushTaskReady).toHaveBeenCalled();
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['kid', 'mum', 'dad'] }, 'task');
  });

  it('is only for an adult who looks after the child right now', async () => {
    setUp();
    supervisorsOf.mockResolvedValue(['dad']);
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    // Not the head either, unless they look after the child.
    await expect(decideSubmission(H, { id: 'boss', role: 'head' }, { submissionId: 's1', decision: 'approve' })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    expect(writes).toEqual([]);
  });

  it('says plainly when someone else decided it first', async () => {
    setUp();
    prisma.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }));
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' })).rejects.toThrow('Someone already decided this.');
    setUp(check({ status: 'approved', decidedById: 'dad', decidedAt: NOW }));
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toThrow(
      'Someone already decided this.',
    );
    expect(writes).toEqual([]);
  });

  it('rolls first, and won’t turn a send back into a take-back because the day just ended', async () => {
    setUp(check({ status: 'auto_approved', autoReason: 'cycle_end', decidedAt: NOW }));
    prisma.taskSubmission.findFirst.mockResolvedValue({ taskId: 't1', status: 'waiting' });
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toThrow(
      'This was counted as done when the day ended. Look at it again.',
    );
    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });

  it('a steps check can’t be decided yet; an unknown one is not found', async () => {
    setUp(check({ kind: 'steps' }));
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' })).rejects.toMatchObject({ name: 'ConflictError' });
    prisma.taskSubmission.findFirst.mockResolvedValue(null);
    await expect(decideSubmission(H, mum, { submissionId: 'nope', decision: 'approve' })).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(writes).toEqual([]);
  });
});

describe('decideSubmission: send back', () => {
  it('without steps: the task goes back as it was, every step stays ticked with its points', async () => {
    setUp();
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'The pans are still dirty' });
    expect(written('task.update')).toEqual([{ where: { id: 't1' }, data: { status: 'in_progress' } }]);
    expect(names()).not.toContain('subtask.updateMany');
    expect(names()).not.toContain('pendingCredit.deleteMany');
    expect(names()).not.toContain('taskCompletion.create');
    expect(written('taskSubmission.update')[0].data).toEqual({
      status: 'sent_back',
      decidedById: 'mum',
      decidedAt: NOW,
      reviewNote: 'The pans are still dirty',
      redoStepIds: [],
      photoDeleteAt: new Date(NOW.getTime() + 14 * DAY),
    });
    expect(written('notification.create')[0].data).toMatchObject({ title: 'Sent back: Dishes', body: 'The pans are still dirty' });
    const activity = writes.find(([n]) => n === 'logActivity')![1];
    expect(activity).toMatchObject({ actorId: 'mum', message: 'sent “Dishes” back to Riley' });
    expect(JSON.stringify(activity)).not.toContain('pans');
  });

  it('with steps: those are unticked and lose their queued points; the rest keep theirs', async () => {
    setUp();
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'Again', redoStepIds: ['a', 'a'] });
    expect(written('subtask.updateMany')).toEqual([
      {
        where: { taskId: 't1', id: { in: ['a'] } },
        data: { done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null },
      },
    ]);
    expect(written('pendingCredit.deleteMany')).toEqual([{ where: { taskId: 't1', subtaskId: { in: ['a'] } } }]);
    expect(written('taskSubmission.update')[0].data).toMatchObject({ redoStepIds: ['a'] });
  });

  it('refuses steps from another task, writing nothing', async () => {
    setUp();
    await expect(
      decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'Again', redoStepIds: ['zzz'] }),
    ).rejects.toMatchObject({ name: 'UnprocessableError', field: 'redoStepIds' });
    expect(writes).toEqual([]);
  });
});

describe('decideSubmission: counted as done when the day ended', () => {
  const cycleEnd = (over: Record<string, unknown> = {}) =>
    check({ status: 'auto_approved', autoReason: 'cycle_end', decidedAt: new Date(NOW.getTime() - DAY), completionId: 'done1', ...over });

  it('send back takes back only the child’s points from that completion, once, and keeps the task done', async () => {
    setUp(cycleEnd(), { taskRows: [task({ status: 'pending' })] });
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'Not done' });
    expect(written('pointAward.updateMany')).toEqual([
      {
        where: { completionId: 'done1', userId: 'kid', OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] },
        data: { voidedAt: NOW, voidedById: 'mum', voidReason: 'Points taken back' },
      },
    ]);
    expect(written('taskSubmission.update')[0].data).toEqual({ takenBackAt: NOW, takenBackById: 'mum', reviewNote: 'Not done' });
    expect(names()).not.toContain('task.update');
    expect(written('notification.create')[0].data).toMatchObject({ title: 'Points taken back: Dishes', body: 'Not done' });
    const activity = writes.find(([n]) => n === 'logActivity')![1];
    expect(activity).toMatchObject({ actorId: 'mum', message: 'took back Riley’s points for “Dishes”' });
    expect(JSON.stringify(activity)).not.toContain('Not done');
  });

  it('only once, only for 3 days, only by an adult who looks after the child now', async () => {
    setUp(cycleEnd({ takenBackAt: NOW }), { taskRows: [task()] });
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toThrow(
      'Someone already decided this.',
    );
    setUp(cycleEnd({ decidedAt: new Date(NOW.getTime() - 4 * DAY) }), { taskRows: [task()] });
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toThrow(
      'Points can only be taken back for 3 days after the day ended.',
    );
    setUp(cycleEnd(), { taskRows: [task()] });
    supervisorsOf.mockResolvedValue([]);
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toMatchObject({
      name: 'ForbiddenError',
    });
    // A check counted as done because nobody looked after the child is not one of these.
    setUp(cycleEnd({ autoReason: 'unsupervised' }), { taskRows: [task()] });
    await expect(decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'x' })).rejects.toThrow(
      'Someone already decided this.',
    );
    expect(writes).toEqual([]);
  });

  it('approve clears it from To check without touching any points', async () => {
    setUp(cycleEnd(), { taskRows: [task()] });
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'approve' });
    expect(writes).toEqual([['taskSubmission.update', { where: { id: 's1' }, data: { decidedById: 'mum' } }]]);
  });
});

describe('withdrawSubmission', () => {
  it('the child takes back their own: task back as it was, photo deleted, supervisors’ rows removed', async () => {
    setUp();
    const taskId = await withdrawSubmission(H, kid, 's1');
    expect(taskId).toBe('t1');
    expect(writes).toEqual([
      ['taskSubmission.update', { where: { id: 's1' }, data: { status: 'withdrawn', decidedAt: NOW } }],
      ['taskPhoto.deleteMany', { where: { submissionId: 's1' } }],
      ['notification.deleteMany', { where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s1:' } } }],
      ['task.updateMany', { where: { id: 't1', status: 'awaiting_review' }, data: { status: 'in_progress' } }],
    ]);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
  });

  it('only theirs, only while it waits', async () => {
    setUp();
    await expect(withdrawSubmission(H, mum, 's1')).rejects.toMatchObject({ name: 'ForbiddenError' });
    setUp(check({ status: 'approved' }));
    await expect(withdrawSubmission(H, kid, 's1')).rejects.toThrow('Someone already decided this.');
    setUp();
    prisma.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }));
    await expect(withdrawSubmission(H, kid, 's1')).rejects.toThrow('Someone already decided this.');
    expect(writes).toEqual([]);
  });
});

describe('settleOrphanedSubmissions', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    prisma.taskSubmission.findMany.mockResolvedValue([{ id: 's1', taskId: 't1' }]);
    tx.taskSubmission.findFirst.mockResolvedValue(check());
    supervisorsOf.mockResolvedValue(['mum']);
  });
  afterEach(() => log.mockRestore());

  it('withdraws a check whose child is gone, unpaid, and says so in one line of ids', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(written('taskSubmission.update')[0].data).toEqual({ status: 'withdrawn', decidedAt: NOW });
    expect(names()).not.toContain('taskCompletion.create');
    expect(log).toHaveBeenCalledWith('[tasks] settled check s1 on task t1: withdrawn');
  });

  it('withdraws one whose child is no longer a teen or child', async () => {
    tx.user.findFirst.mockResolvedValue({ ...KID_ROW, role: 'adult' });
    await settleOrphanedSubmissions(H, NOW);
    expect(written('taskSubmission.update')[0].data).toMatchObject({ status: 'withdrawn' });
  });

  it('counts one as done when nobody looks after the child now, deleting the photo at once', async () => {
    tx.user.findFirst.mockResolvedValue(KID_ROW);
    tx.supervision.findMany.mockResolvedValue([]);
    supervisorsOf.mockResolvedValue([]);
    tx.task.findFirst.mockResolvedValueOnce({ photoProof: null }).mockResolvedValueOnce(task());
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(written('taskCompletion.create')[0].data).toMatchObject({ userId: 'kid', completedAt: SENT, recordedAt: NOW, submissionId: 's1' });
    expect(written('taskSubmission.update')[0].data).toEqual({
      status: 'auto_approved',
      autoReason: 'unsupervised',
      decidedById: null,
      decidedAt: NOW,
      completionId: 'done1',
      takenBackAt: null,
    });
    expect(written('taskPhoto.deleteMany')).toEqual([{ where: { submissionId: 's1' } }]);
    expect(log).toHaveBeenCalledWith('[tasks] settled check s1 on task t1: auto_approved');
    // Rolled afterwards, like an approval.
    expect(prisma.task.findMany).toHaveBeenCalledTimes(2);
  });

  it('counts one as done when checks were turned off and the task doesn’t ask for a photo', async () => {
    tx.user.findFirst.mockResolvedValue({ ...KID_ROW, reviewTasks: null });
    tx.supervision.findMany.mockResolvedValue([{ supervisor: { role: 'adult' } }]);
    tx.task.findFirst.mockResolvedValueOnce({ photoProof: null }).mockResolvedValueOnce(task());
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(written('taskSubmission.update')[0].data).toMatchObject({ status: 'auto_approved', autoReason: 'unsupervised' });
  });

  it('leaves one that still needs a check: checks on, or a task that asks for a photo', async () => {
    tx.user.findFirst.mockResolvedValue({ ...KID_ROW, reviewTasks: null });
    tx.supervision.findMany.mockResolvedValue([{ supervisor: { role: 'adult' } }]);
    tx.task.findFirst.mockResolvedValueOnce({ photoProof: true });
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(0);
    tx.user.findFirst.mockResolvedValue(KID_ROW);
    tx.task.findFirst.mockResolvedValueOnce({ photoProof: null });
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(0);
    expect(writes).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('opens tasks left waiting with nothing to wait for first', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't9', status: 'awaiting_review' }]);
    prisma.taskSubmission.findFirst.mockResolvedValueOnce(null);
    prisma.taskSubmission.findMany.mockResolvedValue([]);
    await settleOrphanedSubmissions(H, NOW);
    expect(written('prisma.task.update')).toEqual([{ where: { id: 't9' }, data: { status: 'pending' } }]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('one check failing never stops the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    prisma.taskSubmission.findMany.mockResolvedValue([{ id: 's1', taskId: 't1' }, { id: 's2', taskId: 't2' }]);
    prisma.$transaction.mockRejectedValueOnce(new Error('boom'));
    tx.user.findFirst.mockResolvedValue(null);
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('listSubmissions (To check and the child’s own)', () => {
  const links = [{ supervisedId: 'kid', supervisor: { role: 'adult' }, supervised: { role: 'child' } }];
  function rows() {
    prisma.taskSubmission.findMany.mockResolvedValueOnce([
      check(),
      check({ id: 's2', taskId: 't1', status: 'auto_approved', autoReason: 'cycle_end', decidedAt: new Date(NOW.getTime() - DAY), completionId: 'c9', note: null, stepIds: [] }),
    ]);
    prisma.task.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([task({ status: 'awaiting_review' })]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'kid', name: 'Riley' }, { id: 'mum', name: 'Mum' }]);
    prisma.taskPhoto.findMany.mockResolvedValueOnce([{ submissionId: 's1' }]);
    prisma.pointAward.findMany.mockResolvedValueOnce([
      { completionId: 'c9', userId: 'kid', pointsCenti: 300 },
      { completionId: 'c9', userId: 'sib', pointsCenti: 100 },
    ]);
  }

  it('gives an adult who looks after the child each item with what they may do', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce(links);
    rows();
    const items = await listSubmissions(H, 'mum', NOW);
    // Only the children they look after, plus their own, from the session.
    expect(prisma.taskSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ householdId: H, userId: { in: ['kid', 'mum'] } }) }),
    );
    expect(items).toEqual([
      {
        id: 's1',
        kind: 'task',
        status: 'waiting',
        autoReason: null,
        task: { id: 't1', title: 'Dishes' },
        child: { id: 'kid', name: 'Riley' },
        submittedAt: SENT.toISOString(),
        note: 'All done',
        hasPhoto: true,
        points: 2,
        steps: [
          { id: 'a', title: 'Step a', ticked: true },
          { id: 'b', title: 'Step b', ticked: false },
        ],
        stepsTicked: 1,
        decideBy: null,
        entries: [],
        actions: ['approve', 'send_back'],
      },
      expect.objectContaining({
        id: 's2',
        status: 'auto_approved',
        autoReason: 'cycle_end',
        hasPhoto: false,
        // What the child was paid, not anyone else.
        points: 3,
        decideBy: new Date(NOW.getTime() + 2 * DAY).toISOString(),
        actions: ['approve', 'send_back'],
      }),
    ]);
  });

  it('gives the child their own, with Take back on the waiting one only', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([]);
    rows();
    const items = await listSubmissions(H, 'kid', NOW);
    expect(prisma.taskSubmission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: ['kid'] } }) }),
    );
    expect(items.map((i) => i.actions)).toEqual([['withdraw'], []]);
  });

  it('shows a steps check’s entries as stored', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce(links);
    prisma.taskSubmission.findMany.mockResolvedValueOnce([
      check({
        kind: 'steps',
        stepIds: [],
        note: null,
        entries: JSON.stringify([
          { subtaskId: 'a', title: 'Step a', pointsCenti: 100, checkedAt: SENT.toISOString(), awardKind: 'step_repeat' },
          { subtaskId: 'b', title: 'Step b', pointsCenti: 300, checkedAt: SENT.toISOString(), awardKind: 'step', completionId: 'c1' },
        ]),
      }),
    ]);
    prisma.task.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([task()]);
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'kid', name: 'Riley' }, { id: 'sam', name: 'Sam' }]);
    prisma.taskCompletion.findMany.mockResolvedValueOnce([{ id: 'c1', userId: 'sam' }]);
    const [item] = await listSubmissions(H, 'mum', NOW);
    expect(item.kind).toBe('steps');
    expect(item.points).toBe(4);
    expect(item.entries).toEqual([
      { subtaskId: 'a', title: 'Step a', points: 1, checkedAt: SENT.toISOString(), awardKind: 'step_repeat', completionId: null, completedBy: null },
      { subtaskId: 'b', title: 'Step b', points: 3, checkedAt: SENT.toISOString(), awardKind: 'step', completionId: 'c1', completedBy: { id: 'sam', name: 'Sam' } },
    ]);
  });
});

describe('submissionPhoto: who may see it', () => {
  const PHOTO = new Uint8Array([0xff, 0xd8]);
  beforeEach(() => {
    prisma.taskSubmission.findFirst.mockResolvedValue({ id: 's1', userId: 'kid' });
    prisma.taskPhoto.findUnique.mockResolvedValue({ jpeg: PHOTO });
  });

  it('the child who sent it, and an adult who looks after them now', async () => {
    expect(await submissionPhoto(H, 'kid', 's1')).toBe(PHOTO);
    supervisorsOf.mockResolvedValue(['mum']);
    expect(await submissionPhoto(H, 'mum', 's1')).toBe(PHOTO);
    expect(prisma.taskSubmission.findFirst).toHaveBeenCalledWith({ where: { id: 's1', householdId: H }, select: { id: true, userId: true } });
  });

  it('nobody else, the head included, and nothing from another household: all simply not found', async () => {
    supervisorsOf.mockResolvedValue(['mum']);
    await expect(submissionPhoto(H, 'dad', 's1')).rejects.toMatchObject({ name: 'NotFoundError', message: 'No photo for that check.' });
    await expect(submissionPhoto(H, 'boss', 's1')).rejects.toMatchObject({ name: 'NotFoundError' });
    supervisorsOf.mockResolvedValue([]);
    await expect(submissionPhoto(H, 'mum', 's1')).rejects.toMatchObject({ name: 'NotFoundError' });
    prisma.taskSubmission.findFirst.mockResolvedValue(null);
    await expect(submissionPhoto('other', 'kid', 's1')).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(prisma.taskPhoto.findUnique).not.toHaveBeenCalled();
  });

  it('not found once the photo is deleted', async () => {
    prisma.taskPhoto.findUnique.mockResolvedValue(null);
    await expect(submissionPhoto(H, 'kid', 's1')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

describe('countTasksToCheck and deleteExpiredPhotos', () => {
  it('counts what waits on an adult in To check, and nothing for someone who looks after nobody', async () => {
    prisma.supervision.findMany.mockResolvedValueOnce([{ supervisedId: 'kid', supervisor: { role: 'adult' }, supervised: { role: 'child' } }]);
    prisma.taskSubmission.count.mockResolvedValueOnce(2);
    expect(await countTasksToCheck(H, 'mum', NOW)).toBe(2);
    expect(prisma.taskSubmission.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ householdId: H, userId: { in: ['kid'] } }),
    });
    prisma.supervision.findMany.mockResolvedValueOnce([]);
    expect(await countTasksToCheck(H, 'kid', NOW)).toBe(0);
    expect(prisma.taskSubmission.count).toHaveBeenCalledTimes(1);
  });

  it('deletes the photos of checks decided 14 days ago, and only those', async () => {
    prisma.taskPhoto.findMany.mockResolvedValueOnce([{ submissionId: 's1' }, { submissionId: 's2' }]);
    prisma.taskSubmission.findMany.mockResolvedValueOnce([{ id: 's1' }]);
    expect(await deleteExpiredPhotos(H, NOW)).toBe(1);
    expect(prisma.taskSubmission.findMany).toHaveBeenCalledWith({
      where: { householdId: H, id: { in: ['s1', 's2'] }, photoDeleteAt: { lte: NOW } },
      select: { id: true },
    });
    expect(written('prisma.taskPhoto.deleteMany')).toEqual([{ where: { householdId: H, submissionId: { in: ['s1'] } } }]);
  });
});
