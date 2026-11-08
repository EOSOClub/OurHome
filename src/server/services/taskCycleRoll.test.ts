import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Cycle roll-overs and the races around them in taskService: two rolls of one
// task at once, windows before a task's first due date, "every 2 weeks"
// cycles, cycles switched on after a completion, plus reordering and the
// plain answers for steps and tasks that went away. A recording stand-in for
// Prisma keeps every write in order (as in taskServiceChecks.test.ts).

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
    findFirstOrThrow: vi.fn(async (): Promise<unknown> => stored),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    create: writer('task.create', (arg: { data: Record<string, unknown> }) => ({ ...arg.data, id: 't2', subtasks: [], recurrence: null })),
    update: writer('task.update', (arg: { data: Record<string, unknown> }) => ({ ...stored, ...arg.data })),
    updateMany: writer('task.updateMany'),
    delete: writer('task.delete'),
  },
  taskCompletion: {
    create: writer('taskCompletion.create', (arg: { data: Record<string, unknown> }) => ({ id: 'done1', ...arg.data })),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
    update: writer('taskCompletion.update'),
  },
  taskSubmission: { findFirst: vi.fn(async (): Promise<unknown> => null), count: vi.fn(async () => 0) },
  notification: { deleteMany: writer('notification.deleteMany') },
  pendingCredit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    deleteMany: writer('pendingCredit.deleteMany'),
    createMany: writer('pendingCredit.createMany'),
  },
  pointAward: { createMany: writer('pointAward.createMany') },
  subtask: {
    update: writer('subtask.update'),
    updateMany: writer('subtask.updateMany'),
    create: writer('subtask.create', (arg: { data: Record<string, unknown> }) => ({ id: 'new', ...arg.data })),
    delete: writer('subtask.delete'),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  recurrenceRule: {
    update: writer('recurrenceRule.update', (arg: { data: Record<string, unknown> }) => ({ id: 'r1', ...arg.data })),
    create: writer('recurrenceRule.create', (arg: { data: Record<string, unknown> }) => ({ id: 'r1', ...arg.data })),
    delete: writer('recurrenceRule.delete'),
  },
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => ({ id: 'mum', role: 'adult', reviewTasks: null, name: 'Mum' })),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
const prisma = {
  task: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => stored),
  },
  household: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 })) },
  subtask: { findFirst: vi.fn(async (): Promise<unknown> => ({ taskId: 't1' })) },
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
vi.mock('@/server/services/pushService', () => ({ pushSync: vi.fn() }));

const {
  addSubtask,
  completeTask,
  createTask,
  cycleSpecFor,
  deleteSubtask,
  deleteTask,
  getTaskOrThrow,
  reorderSubtasks,
  reorderTasks,
  rollTaskCycles,
  updateSubtask,
  updateTask,
} = await import('./taskService');
const { Prisma } = await import('@prisma/client');

const H = 'household1';
const conflict = () => new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' });
const gone = () => new Prisma.PrismaClientKnownRequestError('gone', { code: 'P2025', clientVersion: 'test' });
const SAME_MOMENT = { name: 'ConflictError', message: 'Someone else changed this at the same moment. Try again.' };
const d = (iso: string) => new Date(iso);

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
    title: 'Bins',
    notes: null,
    type: 'recurring',
    priority: 'medium',
    status: 'pending',
    dueDate: null,
    completedAt: null,
    estimatedMinutes: 20,
    pointsCenti: 200,
    baseMinutes: 20,
    basePointsCenti: 200,
    pointsFollowTime: true,
    cycleStartedAt: null,
    cycleEndsAt: null,
    opensAt: null,
    assigneeId: 'sam',
    rotationUserIds: 'sam,mia',
    categoryId: null,
    roomId: null,
    floorId: null,
    extraRoomIds: [],
    extraFloorIds: [],
    recurrence: null,
    recurrenceId: null,
    photoProof: null,
    updatedAt: d('2026-11-01T12:00:00.000Z'),
    subtasks: [step('a'), step('b', { position: 1 })],
    ...over,
  };
}

function rule(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    kind: 'weekly',
    interval: 1,
    byWeekday: '1',
    byMonthday: null,
    cron: null,
    timezone: 'UTC',
    anchorDate: d('2026-11-02T18:00:00.000Z'),
    until: null,
    nextRunAt: d('2026-11-02T18:00:00.000Z'),
    rollover: true,
    cycleWeekdays: '1',
    cycleMonthdays: null,
    ...over,
  };
}

/** Rolls task t1 (stored as [row]) at [now]. */
function roll(row: Record<string, unknown>, now: Date) {
  stored = row;
  prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
  return rollTaskCycles(H, now, 't1');
}
const lastTaskUpdate = () => written('task.update').at(-1)!.data;

beforeEach(() => {
  vi.resetAllMocks();
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(d('2026-11-09T07:00:00.000Z'));
  stored = task();
  // Sam and Mia are both members (the rotation).
  tx.user.findMany.mockResolvedValue([{ id: 'sam' }, { id: 'mia' }]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('two rolls of one task at once', () => {
  beforeEach(() => {
    vi.setSystemTime(d('2026-10-29T15:00:00.000Z'));
    stored = task({ type: 'one_time', assigneeId: 'mum', rotationUserIds: null, dueDate: d('2026-10-29T17:00:00.000Z') });
  });

  it('the roll that lost is run again (finding the work done) and the completion goes on', async () => {
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    prisma.$transaction.mockRejectedValueOnce(conflict());
    const out = await completeTask(H, { id: 'mum', role: 'adult' }, { taskId: 't1' });
    expect(out.completionId).toBe('done1');
    // Once lost, once run again, once completing: one completion only.
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(written('taskCompletion.create')).toHaveLength(1);
  });

  it('a roll that keeps losing is told plainly (409), never a 500, for a completion and a step tick', async () => {
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    prisma.$transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    await expect(completeTask(H, { id: 'mum', role: 'adult' }, { taskId: 't1' })).rejects.toMatchObject(SAME_MOMENT);

    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    prisma.$transaction.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    await expect(updateSubtask(H, { subtaskId: 'a', done: true }, { id: 'mum', role: 'adult' })).rejects.toMatchObject(SAME_MOMENT);
    expect(names()).not.toContain('taskCompletion.create');
  });

  it('a sweep roll that loses is run again too, and other errors are only logged as before', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    prisma.$transaction.mockRejectedValueOnce(conflict());
    expect(await rollTaskCycles(H, new Date())).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    prisma.$transaction.mockRejectedValueOnce(new Error('boom'));
    await rollTaskCycles(H, new Date());
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('windows before a task’s first due date', () => {
  it('a weekly cycle task made mid-week is not missed, nor its turn passed, before its first Monday', async () => {
    // Made on Wed Nov 4, cycles start Mondays, first due Mon Nov 9 at noon.
    const first = d('2026-11-09T18:00:00.000Z');
    await roll(
      task({
        recurrence: rule({ anchorDate: first, nextRunAt: first }),
        recurrenceId: 'r1',
        dueDate: first,
        cycleStartedAt: d('2026-11-02T06:00:00.000Z'),
        cycleEndsAt: d('2026-11-09T06:00:00.000Z'),
      }),
      d('2026-11-09T07:00:00.000Z'),
    );
    expect(names()).not.toContain('taskCompletion.create');
    const data = lastTaskUpdate();
    expect(data).toMatchObject({ status: 'pending', dueDate: first, cycleStartedAt: d('2026-11-09T06:00:00.000Z'), cycleEndsAt: d('2026-11-16T06:00:00.000Z') });
    expect(data.assigneeId).toBeUndefined();
  });

  it('a window wholly before the first due date keeps that due date, not the window’s last minute', async () => {
    // Every 3 days, first due Nov 30: Nov 9 to Nov 12 has nothing due in it.
    const first = d('2026-11-30T18:00:00.000Z');
    await roll(
      task({
        recurrence: rule({ kind: 'interval', interval: 3, byWeekday: null, cycleWeekdays: null, anchorDate: first, nextRunAt: first }),
        recurrenceId: 'r1',
        dueDate: first,
        cycleStartedAt: d('2026-11-06T06:00:00.000Z'),
        cycleEndsAt: d('2026-11-09T06:00:00.000Z'),
      }),
      d('2026-11-09T07:00:00.000Z'),
    );
    expect(names()).not.toContain('taskCompletion.create');
    expect(lastTaskUpdate()).toMatchObject({ dueDate: first, cycleEndsAt: d('2026-11-12T06:00:00.000Z') });
    expect(lastTaskUpdate().assigneeId).toBeUndefined();
  });

  it('a window after the first due date is still missed, and the turn passes, as before', async () => {
    await roll(
      task({
        recurrence: rule(),
        recurrenceId: 'r1',
        dueDate: d('2026-11-02T18:00:00.000Z'),
        cycleStartedAt: d('2026-11-02T06:00:00.000Z'),
        cycleEndsAt: d('2026-11-09T06:00:00.000Z'),
      }),
      d('2026-11-09T07:00:00.000Z'),
    );
    expect(written('taskCompletion.create').map((c) => c.data)).toEqual([
      { taskId: 't1', userId: null, outcome: 'missed', completedAt: d('2026-11-09T06:00:00.000Z') },
    ]);
    expect(lastTaskUpdate()).toMatchObject({ assigneeId: 'mia', dueDate: d('2026-11-09T18:00:00.000Z') });
  });
});

describe('every 2 weeks with cycles', () => {
  const biweekly = (over: Record<string, unknown> = {}) => rule({ interval: 2, ...over });

  it('opens a cycle every other Monday, counted from the rule’s first week', () => {
    const spec = cycleSpecFor(biweekly() as never);
    expect(spec).toMatchObject({ kind: 'weekdays', days: [1], everyWeeks: 2 });
    // Every month too; one week or month stays as it was.
    expect(cycleSpecFor(rule({ kind: 'monthly', interval: 3, cycleMonthdays: '1', cycleWeekdays: null }) as never)).toMatchObject({ kind: 'monthdays', days: [1], everyMonths: 3 });
    expect(cycleSpecFor(rule() as never)).toEqual({ kind: 'weekdays', days: [1] });
  });

  it('the off week is part of the on week’s cycle: no due date, miss or turn of its own', async () => {
    // Done in the on week; the cycle runs Nov 2 to Nov 16.
    await roll(
      task({
        recurrence: biweekly(),
        recurrenceId: 'r1',
        status: 'pending',
        dueDate: d('2026-11-02T18:00:00.000Z'),
        cycleStartedAt: d('2026-11-02T06:00:00.000Z'),
        cycleEndsAt: d('2026-11-16T06:00:00.000Z'),
      }),
      d('2026-11-16T07:00:00.000Z'),
    );
    // One window ended: one miss, one turn; the next opens Nov 16 for two weeks.
    expect(written('taskCompletion.create')).toHaveLength(1);
    expect(lastTaskUpdate()).toMatchObject({
      assigneeId: 'mia',
      dueDate: d('2026-11-16T18:00:00.000Z'),
      cycleStartedAt: d('2026-11-16T06:00:00.000Z'),
      cycleEndsAt: d('2026-11-30T06:00:00.000Z'),
    });
  });

  it('a one-week window saved before the interval counted runs on to the real end, untouched', async () => {
    await roll(
      task({
        recurrence: biweekly(),
        recurrenceId: 'r1',
        status: 'completed',
        completedAt: d('2026-11-03T18:00:00.000Z'),
        dueDate: d('2026-11-02T18:00:00.000Z'),
        cycleStartedAt: d('2026-11-02T06:00:00.000Z'),
        cycleEndsAt: d('2026-11-09T06:00:00.000Z'),
      }),
      d('2026-11-09T07:00:00.000Z'),
    );
    expect(writes).toEqual([['task.update', { where: { id: 't1' }, data: { cycleEndsAt: d('2026-11-16T06:00:00.000Z') } }]]);
  });

  it('a weekly task whose saved end is an hour off (the zone changed) still rolls, as before', async () => {
    // Saved under New York (midnight is 05:00Z); the household is now in Chicago.
    await roll(
      task({
        recurrence: rule(),
        recurrenceId: 'r1',
        status: 'completed',
        completedAt: d('2026-11-03T18:00:00.000Z'),
        dueDate: d('2026-11-02T17:00:00.000Z'),
        cycleStartedAt: d('2026-11-02T05:00:00.000Z'),
        cycleEndsAt: d('2026-11-09T05:00:00.000Z'),
      }),
      d('2026-11-09T07:00:00.000Z'),
    );
    // Not pushed a week on (which only moved cycleEndsAt and left it "done"):
    // the done window closed and a new one opened, open to earn again.
    const data = lastTaskUpdate();
    expect(data.status).toBe('pending');
    expect(data.cycleStartedAt).toBeInstanceOf(Date);
    expect((data.cycleEndsAt as Date).getTime()).toBeGreaterThan(d('2026-11-09T07:00:00.000Z').getTime());
  });
});

describe('switching cycles on after today’s occurrence was completed', () => {
  // Daily, Ana then Ben. Ana completed it Mon Nov 9 at 17:00 local; without
  // cycles that made it Ben's, open from Tue 00:00, due Tue noon.
  const DONE = d('2026-11-09T23:00:00.000Z');
  const TUE = d('2026-11-10T06:00:00.000Z');
  const TUE_NOON = d('2026-11-10T18:00:00.000Z');
  const daily = rule({ kind: 'daily', byWeekday: null, cycleWeekdays: null, rollover: false, anchorDate: TUE_NOON, nextRunAt: TUE_NOON });
  const afterAna = () =>
    task({ recurrence: daily, recurrenceId: 'r1', assigneeId: 'ben', rotationUserIds: 'ana,ben', dueDate: TUE_NOON, opensAt: TUE, subtasks: [] });
  const completion = { id: 'c1', taskId: 't1', userId: 'ana', outcome: 'completed', completedAt: DONE, snapshot: JSON.stringify({ assigneeId: 'ana' }) };

  beforeEach(() => {
    vi.setSystemTime(d('2026-11-10T02:00:00.000Z')); // Mon 20:00 local
    tx.user.findMany.mockResolvedValue([{ id: 'ana' }, { id: 'ben' }]);
  });

  it('counts that completion for the new window: done, open again at its end, and still Ana’s turn until then', async () => {
    stored = afterAna();
    tx.taskCompletion.findFirst.mockResolvedValueOnce(completion);
    await updateTask(H, 'mum', { taskId: 't1', assigneeId: 'ben', recurrence: { kind: 'daily', interval: 1, timezone: 'UTC', rollover: true } });
    expect(tx.taskCompletion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ taskId: 't1', outcome: 'completed', completedAt: { gte: d('2026-11-09T06:00:00.000Z') } }) }),
    );
    expect(lastTaskUpdate()).toMatchObject({
      status: 'completed',
      completedAt: DONE,
      opensAt: null,
      assigneeId: 'ana',
      cycleStartedAt: d('2026-11-09T06:00:00.000Z'),
      cycleEndsAt: TUE,
    });
    expect(ready.clearTaskReady).toHaveBeenCalled();
  });

  it('at midnight nothing is missed and the turn passes once, to Ben', async () => {
    vi.setSystemTime(d('2026-11-10T06:30:00.000Z'));
    await roll(
      task({
        recurrence: { ...daily, rollover: true },
        recurrenceId: 'r1',
        rotationUserIds: 'ana,ben',
        assigneeId: 'ana',
        status: 'completed',
        completedAt: DONE,
        dueDate: TUE_NOON,
        cycleStartedAt: d('2026-11-09T06:00:00.000Z'),
        cycleEndsAt: TUE,
        subtasks: [],
      }),
      d('2026-11-10T06:30:00.000Z'),
    );
    expect(names()).not.toContain('taskCompletion.create');
    expect(lastTaskUpdate()).toMatchObject({ status: 'pending', assigneeId: 'ben' });
  });

  it('with no completion in the window, switching on changes nothing else, as before', async () => {
    stored = afterAna();
    await updateTask(H, 'mum', { taskId: 't1', recurrence: { kind: 'daily', interval: 1, timezone: 'UTC', rollover: true } });
    const data = lastTaskUpdate();
    expect(data.status).toBeUndefined();
    expect(data).not.toHaveProperty('opensAt');
    expect(data).toMatchObject({ cycleStartedAt: d('2026-11-09T06:00:00.000Z'), cycleEndsAt: TUE });
  });
});

describe('reordering tasks', () => {
  it('moves them without counting as an edit (Undo of a completion still works after)', async () => {
    const t1At = d('2026-11-01T10:00:00.000Z');
    const t2At = d('2026-11-01T11:00:00.000Z');
    tx.task.findMany.mockResolvedValueOnce([{ id: 't1', updatedAt: t1At }, { id: 't2', updatedAt: t2At }]);
    await reorderTasks(H, { taskIds: ['t2', 't1', 'elsewhere'] });
    expect(tx.task.findMany).toHaveBeenCalledWith({
      where: { householdId: H, id: { in: ['t2', 't1', 'elsewhere'] } },
      select: { id: true, updatedAt: true },
    });
    // Ids outside the household are ignored, as before.
    expect(writes).toEqual([
      ['task.update', { where: { id: 't2' }, data: { position: 0, updatedAt: t2At } }],
      ['task.update', { where: { id: 't1' }, data: { position: 1, updatedAt: t1At } }],
    ]);
  });

  it('a reorder at the same moment as another change is told plainly (409)', async () => {
    prisma.$transaction.mockRejectedValueOnce(conflict());
    await expect(reorderTasks(H, { taskIds: ['t1'] })).rejects.toMatchObject(SAME_MOMENT);
  });
});

describe('races on steps and tasks: plain answers, never a 500', () => {
  beforeEach(() => {
    stored = task({ type: 'one_time', recurrence: null, rotationUserIds: null });
    prisma.task.findFirst.mockResolvedValue({ id: 't1' });
    prisma.subtask.findFirst.mockResolvedValue({ taskId: 't1' });
  });

  it('a write conflict in create, delete, add step, delete step or step order is a 409', async () => {
    for (const run of [
      () => createTask(H, 'mum', { title: 'Bins', type: 'one_time', priority: 'medium' }),
      () => deleteTask(H, 'mum', 't1'),
      () => addSubtask(H, { taskId: 't1', title: 'More' }),
      () => deleteSubtask(H, 'a'),
      () => reorderSubtasks(H, { taskId: 't1', subtaskIds: ['b', 'a'] }),
    ]) {
      prisma.$transaction.mockRejectedValueOnce(conflict());
      await expect(run()).rejects.toMatchObject(SAME_MOMENT);
    }
  });

  it('deleting a step twice at once: the second is told it was already removed (404)', async () => {
    const removed = { name: 'NotFoundError', message: 'That step was already removed.' };
    // Gone from the task by the time the transaction reads it.
    tx.task.findFirst.mockResolvedValueOnce(task({ subtasks: [step('b', { position: 1 })] }));
    await expect(deleteSubtask(H, 'a')).rejects.toMatchObject(removed);
    // Or gone between the read and the delete.
    tx.subtask.delete.mockRejectedValueOnce(gone());
    await expect(deleteSubtask(H, 'a')).rejects.toMatchObject(removed);
    expect(names()).not.toContain('subtask.update');
  });

  it('a task deleted in between is a plain 404 for adding, removing and ticking steps', async () => {
    const missing = { name: 'TaskNotFoundError', message: 'That task isn’t there any more.' };
    for (const run of [
      () => addSubtask(H, { taskId: 't1', title: 'More' }),
      () => deleteSubtask(H, 'a'),
      () => updateSubtask(H, { subtaskId: 'a', done: true }, { id: 'mum', role: 'adult' }),
      () => updateSubtask(H, { subtaskId: 'a', title: 'New name' }, { id: 'mum', role: 'adult' }),
    ]) {
      tx.task.findFirst.mockResolvedValueOnce(null);
      tx.task.findFirstOrThrow.mockRejectedValueOnce(gone());
      await expect(run()).rejects.toMatchObject(missing);
    }
  });

  it('says not found and order changes in household words, with no ids', async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    const err = await getTaskOrThrow(H, 'cmabcdefghijklmnopqrstuvw').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'TaskNotFoundError', message: 'That task isn’t there any more.', taskId: 'cmabcdefghijklmnopqrstuvw' });
    prisma.subtask.findFirst.mockResolvedValue(null);
    await expect(deleteSubtask(H, 'sub1')).rejects.toMatchObject({
      name: 'SubtaskNotFoundError',
      message: 'That step isn’t on this task any more.',
      subtaskId: 'sub1',
    });
    prisma.task.findFirst.mockResolvedValue({ id: 't1' });
    tx.subtask.findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const order = await reorderSubtasks(H, { taskId: 't1', subtaskIds: ['b', 'a'] }).catch((e: unknown) => e);
    expect(order).toMatchObject({ name: 'SubtaskOrderConflictError', message: 'The checklist changed while you were moving steps. Try again.' });
    expect((order as Error).message).not.toContain('t1');
  });
});
