import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// completeTask / completeInTx / undoCompletion against a recording stand-in
// for Prisma: every write is kept in order, so a completion's rows can be
// compared with what completing has always written.

type Call = [string, unknown];
const writes: Call[] = [];
/** A stand-in for one Prisma method that records its call and answers with [answer]. */
function writer(name: string, answer: (arg: never) => unknown = () => ({ count: 1 })) {
  return vi.fn(async (arg: never) => {
    writes.push([name, arg]);
    return answer(arg);
  });
}

let stored: Record<string, unknown> = {};
const tx = {
  task: {
    findFirst: vi.fn(async (): Promise<unknown> => stored),
    update: writer('task.update', (arg: { data: Record<string, unknown> }) => ({ ...stored, ...arg.data })),
  },
  taskCompletion: {
    create: writer('taskCompletion.create', (arg: { data: Record<string, unknown> }) => ({ id: 'done1', ...arg.data })),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
    update: writer('taskCompletion.update'),
  },
  taskSubmission: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  pendingCredit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    count: vi.fn(async () => 0),
    deleteMany: writer('pendingCredit.deleteMany'),
    createMany: writer('pendingCredit.createMany'),
  },
  pointAward: { createMany: writer('pointAward.createMany'), updateMany: writer('pointAward.updateMany') },
  subtask: { update: writer('subtask.update'), updateMany: writer('subtask.updateMany') },
  recurrenceRule: { update: writer('recurrenceRule.update') },
  // An adult unless a test says otherwise: never checked (needsCheck).
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => ({ role: 'adult', reviewTasks: null, name: 'Mum' })),
  },
};
const prisma = {
  task: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  household: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 })) },
  $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const logActivity = vi.fn(async (entry: unknown) => {
  writes.push(['logActivity', entry]);
});
vi.mock('@/server/services/activityService', () => ({ logActivity }));
const ready = {
  announceTaskReady: vi.fn(async (): Promise<string | null> => 'next-person'),
  clearTaskReady: vi.fn(async (_tx: unknown, _hh: string, taskId: string) => {
    writes.push(['clearTaskReady', taskId]);
  }),
  pushTaskReady: vi.fn(),
};
vi.mock('@/server/services/taskReadyService', () => ready);
// Who looks after whom (taskReviewService reads it through supervisorsOf); nobody unless a test says so.
const supervisorsOf = vi.fn(async (): Promise<string[]> => []);
vi.mock('@/server/services/pointsTimeService', () => ({ supervisorsOf }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));

const { completeInTx, completeTask, isWriteConflict, undoCompletion } = await import('./taskService');
const { settingsFrom } = await import('./pointsService');
const { Prisma } = await import('@prisma/client');

const H = 'household1';
const NOW = new Date('2026-10-29T15:00:00.000Z');
const SENT = new Date('2026-10-29T13:00:00.000Z');
const QUEUED_AT = new Date('2026-10-29T12:00:00.000Z');
const adult = { id: 'mum', role: 'adult' };
const settings = settingsFrom({ timezone: 'America/Chicago', minutesPerPoint: 10 });

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

/** A one-time task with two steps worth 1 point each; "a" is ticked and queued for the kid. */
function oneTimeTask(over: Record<string, unknown> = {}) {
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
    updatedAt: QUEUED_AT,
    subtasks: [
      step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }),
      step('b', { position: 1 }),
    ],
    ...over,
  };
}
const queuedA = { id: 'pc1', householdId: H, taskId: 't1', subtaskId: 'a', userId: 'kid', checkedAt: QUEUED_AT, cycleStartedAt: null };

const snapshotOf = (task: ReturnType<typeof oneTimeTask>) =>
  JSON.stringify({
    status: task.status,
    completedAt: null,
    dueDate: task.dueDate.toISOString(),
    nextRunAt: null,
    cycleStartedAt: null,
    cycleEndsAt: null,
    opensAt: null,
    assigneeId: 'kid',
    steps: [
      { id: 'a', done: true, doneAt: QUEUED_AT.toISOString(), doneById: 'kid', checkAwardId: null, autoResetAt: null },
      { id: 'b', done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null },
    ],
    pending: [{ subtaskId: 'a', userId: 'kid', checkedAt: QUEUED_AT.toISOString(), cycleStartedAt: null }],
  });

/** What completing the one-time task wrote before completeInTx existed, plus recordedAt. */
function rowsBefore(task: ReturnType<typeof oneTimeTask>, completer: string, at: Date, now: Date, extra: Record<string, unknown> = {}): Call[] {
  return [
    ['taskCompletion.create', {
      data: { taskId: 't1', userId: completer, note: null, outcome: 'completed', completedAt: at, recordedAt: now, snapshot: snapshotOf(task), ...extra },
    }],
    ['pointAward.createMany', {
      data: [
        { householdId: H, userId: 'kid', taskId: 't1', subtaskId: 'a', completionId: 'done1', kind: 'step', pointsCenti: 100, taskTitle: 'Dishes', stepTitle: 'Step a', earnedAt: QUEUED_AT, awardedAt: now },
        { householdId: H, userId: completer, taskId: 't1', subtaskId: 'b', completionId: 'done1', kind: 'step', pointsCenti: 100, taskTitle: 'Dishes', stepTitle: 'Step b', earnedAt: at, awardedAt: now },
      ],
    }],
    ['pendingCredit.deleteMany', { where: { taskId: 't1' } }],
    ['subtask.update', { where: { id: 'a' }, data: { minutes: 10, pointsCenti: 100, minutesCustom: false, pointsFollowTime: true } }],
    ['subtask.update', { where: { id: 'b' }, data: { minutes: 10, pointsCenti: 100, minutesCustom: false, pointsFollowTime: true } }],
    ['task.update', { where: { id: 't1' }, data: { baseMinutes: 20, basePointsCenti: 200, pointsFollowTime: true, estimatedMinutes: 20, pointsCenti: 200 } }],
    ['subtask.updateMany', {
      where: { taskId: 't1', done: false },
      data: { done: true, doneAt: at, doneById: completer, checkAwardId: null, autoResetAt: null },
    }],
    ['task.update', { where: { id: 't1' }, data: { status: 'completed', completedAt: at }, include: expect.any(Object) }],
    ['logActivity', {
      householdId: H,
      actorId: completer,
      verb: 'completed',
      subjectType: 'task',
      subjectId: 't1',
      message: 'completed task “Dishes” (2 pts)',
      metadata: undefined,
    }],
    ['clearTaskReady', 't1'],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  tx.taskSubmission.findFirst.mockResolvedValue(null);
  tx.pendingCredit.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('completeTask (completed by hand): parity with before completeInTx', () => {
  it('writes the same rows as before, with recordedAt equal to completedAt', async () => {
    stored = oneTimeTask();
    tx.pendingCredit.findMany.mockResolvedValueOnce([queuedA]);
    const out = await completeTask(H, adult, { taskId: 't1' });
    expect(writes).toEqual(rowsBefore(oneTimeTask(), 'mum', NOW, NOW));
    expect(out).toEqual({ task: expect.objectContaining({ id: 't1', status: 'completed', completedAt: NOW }), completionId: 'done1' });
    // The roll-over still runs first, and nothing is announced for a finished task.
    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(ready.pushTaskReady).toHaveBeenCalledWith(H, [null]);
    // No submission written onto a completion made by hand.
    const created = writes.find(([name]) => name === 'taskCompletion.create')![1] as { data: object };
    expect(created.data).not.toHaveProperty('submissionId');
  });

  it('moves a recurring task without cycles on, as before', async () => {
    const rule = { id: 'r1', kind: 'daily', interval: 1, byWeekday: null, byMonthday: null, cron: null, anchorDate: new Date('2026-10-01T17:00:00.000Z'), until: null, nextRunAt: new Date('2026-10-29T17:00:00.000Z'), rollover: false, cycleWeekdays: null, cycleMonthdays: null };
    stored = oneTimeTask({ recurrence: rule, type: 'recurring', subtasks: [] });
    const out = await completeTask(H, adult, { taskId: 't1', note: 'Done!' });
    const names = writes.map(([name]) => name);
    expect(names).toEqual([
      'taskCompletion.create',
      'pointAward.createMany',
      'pendingCredit.deleteMany',
      'task.update',
      'recurrenceRule.update',
      'subtask.updateMany',
      'task.update',
      'logActivity',
    ]);
    const created = writes[0][1] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({ completedAt: NOW, recordedAt: NOW, note: 'Done!' });
    // The next one: tomorrow's due date, open from local midnight tonight.
    const nextDue = new Date('2026-10-30T17:00:00.000Z');
    expect(writes[4][1]).toEqual({ where: { id: 'r1' }, data: { nextRunAt: nextDue } });
    expect(writes[6][1]).toMatchObject({
      data: { status: 'pending', completedAt: null, dueDate: nextDue, opensAt: new Date('2026-10-30T05:00:00.000Z') },
    });
    expect(writes[7][1]).toMatchObject({ message: 'completed task “Dishes” (2 pts)', metadata: { note: 'Done!' } });
    // Its next assignee is told once the transaction is done.
    expect(ready.pushTaskReady).toHaveBeenCalledWith(H, ['next-person']);
    expect(out.completionId).toBe('done1');
  });

  it('marks a task with cycles done for this cycle, as before', async () => {
    const rule = { id: 'r1', kind: 'daily', interval: 1, rollover: true, anchorDate: QUEUED_AT, nextRunAt: null };
    stored = oneTimeTask({ recurrence: rule, cycleStartedAt: new Date('2026-10-29T05:00:00.000Z'), cycleEndsAt: new Date('2026-10-30T05:00:00.000Z') });
    tx.pendingCredit.findMany.mockResolvedValueOnce([queuedA]);
    await completeTask(H, adult, { taskId: 't1' });
    expect(writes.map(([name]) => name)).toEqual([
      'taskCompletion.create',
      'pointAward.createMany',
      'pendingCredit.deleteMany',
      'subtask.update',
      'subtask.update',
      'task.update',
      'subtask.updateMany',
      'task.update',
      'logActivity',
      'clearTaskReady',
    ]);
    expect(writes[7][1]).toMatchObject({ data: { status: 'completed', completedAt: NOW } });
  });

  it('refuses what it always refused, writing nothing', async () => {
    stored = oneTimeTask({ status: 'completed' });
    await expect(completeTask(H, adult, { taskId: 't1' })).rejects.toThrow('This task is already completed.');
    stored = oneTimeTask({ status: 'archived', cycleEndsAt: NOW });
    await expect(completeTask(H, adult, { taskId: 't1' })).rejects.toThrow('This task is already done for this cycle.');
    stored = oneTimeTask({ assigneeId: 'someone' });
    await expect(completeTask(H, { id: 'g', role: 'guest' }, { taskId: 't1' })).rejects.toThrow(/Guests may only complete/);
    stored = oneTimeTask({ opensAt: new Date('2026-10-30T05:00:00.000Z') });
    await expect(completeTask(H, adult, { taskId: 't1' })).rejects.toThrow(/already done. The next one opens/);
    expect(writes).toEqual([]);
  });

  it('tells the second of two people completing at once plainly', async () => {
    stored = oneTimeTask();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }),
    );
    await expect(completeTask(H, adult, { taskId: 't1' })).rejects.toThrow('Someone else just completed this task.');
  });
});

describe('completeTask while a task waits for an OK', () => {
  it('refuses a task sent for a check, writing nothing', async () => {
    stored = oneTimeTask({ status: 'awaiting_review' });
    tx.taskSubmission.findFirst.mockResolvedValueOnce({ id: 's1' });
    await expect(completeTask(H, adult, { taskId: 't1' })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'This is waiting for an adult’s OK.',
    });
    expect(writes).toEqual([]);
  });

  it('opens a task left waiting with nothing to wait for, then completes it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stored = oneTimeTask({ status: 'awaiting_review' });
    await completeTask(H, adult, { taskId: 't1' });
    expect(writes[0]).toEqual(['task.update', { where: { id: 't1' }, data: { status: 'pending' } }]);
    expect(writes[1][0]).toBe('taskCompletion.create');
    // Undo puts it back open, not waiting.
    expect(JSON.parse((writes[1][1] as { data: { snapshot: string } }).data.snapshot).status).toBe('pending');
    warn.mockRestore();
  });
});

describe('completeInTx', () => {
  it('records the work when it was done and the points when they land', async () => {
    stored = oneTimeTask();
    tx.pendingCredit.findMany.mockResolvedValueOnce([queuedA]);
    const out = await completeInTx(tx as never, {
      householdId: H,
      completer: { id: 'kid', role: 'child' },
      input: { taskId: 't1' },
      settings,
      at: SENT,
      now: NOW,
      submissionId: 's1',
    });
    expect(writes).toEqual(rowsBefore(oneTimeTask(), 'kid', SENT, NOW, { submissionId: 's1' }));
    expect(out).toEqual({ task: expect.objectContaining({ completedAt: SENT }), completionId: 'done1', ready: null });
    // It neither rolls cycles over nor pushes: its caller does, after committing.
    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(ready.pushTaskReady).not.toHaveBeenCalled();
  });

  it('asks whether the task was open when the work was done', async () => {
    stored = oneTimeTask({ opensAt: new Date('2026-10-29T14:00:00.000Z') });
    const opts = { householdId: H, completer: { id: 'kid', role: 'child' }, input: { taskId: 't1' }, settings, now: NOW };
    await expect(completeInTx(tx as never, { ...opts, at: SENT })).rejects.toThrow(/already done. The next one opens/);
    expect(writes).toEqual([]);
    await completeInTx(tx as never, { ...opts, at: NOW });
    expect(writes[0][0]).toBe('taskCompletion.create');
  });

  it('returns who to tell when the next occurrence opens', async () => {
    const rule = { id: 'r1', kind: 'daily', interval: 1, byWeekday: null, byMonthday: null, cron: null, anchorDate: new Date('2026-10-01T17:00:00.000Z'), until: null, nextRunAt: null, rollover: false };
    stored = oneTimeTask({ recurrence: rule, subtasks: [] });
    const out = await completeInTx(tx as never, { householdId: H, completer: adult, input: { taskId: 't1' }, settings, at: NOW, now: NOW });
    expect(out.ready).toBe('next-person');
  });
});

describe('isWriteConflict', () => {
  it('is Mongo aborting a transaction that clashed, only', () => {
    expect(isWriteConflict(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2034', clientVersion: 'test' }))).toBe(true);
    expect(isWriteConflict(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }))).toBe(false);
    expect(isWriteConflict(new Error('P2034'))).toBe(false);
  });
});

describe('undoCompletion: changed since?', () => {
  const head = { id: 'boss', role: 'head' };
  const snapshot = JSON.stringify({
    status: 'pending', completedAt: null, dueDate: null, nextRunAt: null, cycleStartedAt: null, cycleEndsAt: null,
    opensAt: null, assigneeId: 'kid', steps: [], pending: [],
  });
  function completion(over: Record<string, unknown>) {
    return {
      id: 'done1',
      taskId: 't1',
      userId: 'kid',
      outcome: 'completed',
      undoneAt: null,
      snapshot,
      completedAt: SENT,
      recordedAt: null,
      task: { id: 't1', title: 'Dishes', cycleStartedAt: null, recurrence: null, subtasks: [], updatedAt: SENT },
      ...over,
    };
  }

  it('measures edits from when the completion was written', async () => {
    // Sent at SENT, approved (written) an hour later; the approval itself touched the task.
    const written = new Date('2026-10-29T14:00:00.000Z');
    tx.taskCompletion.findFirst.mockResolvedValueOnce(
      completion({ recordedAt: written, task: { ...completion({}).task, updatedAt: new Date(written.getTime() + 2_000) } }),
    );
    stored = { id: 't1', title: 'Dishes', status: 'pending' };
    await undoCompletion(H, head, 'done1');
    expect(writes.map(([name]) => name)).toContain('taskCompletion.update');
  });

  it('still refuses a task edited after the completion was written', async () => {
    const written = new Date('2026-10-29T14:00:00.000Z');
    tx.taskCompletion.findFirst.mockResolvedValueOnce(
      completion({ recordedAt: written, task: { ...completion({}).task, updatedAt: new Date(written.getTime() + 60_000) } }),
    );
    await expect(undoCompletion(H, head, 'done1')).rejects.toThrow(/changed since it was completed/);
  });

  it('uses completedAt for completions from before recordedAt, as before', async () => {
    tx.taskCompletion.findFirst.mockResolvedValueOnce(
      completion({ task: { ...completion({}).task, updatedAt: new Date(SENT.getTime() + 60_000) } }),
    );
    await expect(undoCompletion(H, head, 'done1')).rejects.toThrow(/changed since it was completed/);

    tx.taskCompletion.findFirst.mockResolvedValueOnce(
      completion({ task: { ...completion({}).task, updatedAt: new Date(SENT.getTime() + 2_000) } }),
    );
    stored = { id: 't1', title: 'Dishes', status: 'pending' };
    await undoCompletion(H, head, 'done1');
    expect(writes.map(([name]) => name)).toContain('taskCompletion.update');
  });
});
