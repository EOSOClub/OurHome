import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task Photo Proof inside taskService: sending a task for a check, the
// compatibility replies, a check at the end of its cycle, undoing an approved
// check, the edit rule while a task waits, and the step locks. A recording
// stand-in for Prisma keeps every write in order (as in taskService.test.ts).

type Call = [string, unknown];
const writes: Call[] = [];
/** A stand-in for one Prisma method that records its call and answers with [answer]. */
function writer(name: string, answer: (arg: never) => unknown = () => ({ count: 1 })) {
  return vi.fn(async (arg: never) => {
    writes.push([name, arg]);
    return answer(arg);
  });
}
const written = (name: string) => writes.filter(([n]) => n === name).map(([, arg]) => arg as { where?: unknown; data: Record<string, unknown> });
const names = () => writes.map(([n]) => n);

let stored: Record<string, unknown> = {};
const ADULT_ROW = { id: 'mum', role: 'adult', reviewTasks: null, name: 'Mum' };
const tx = {
  task: {
    findFirst: vi.fn(async (): Promise<unknown> => stored),
    findFirstOrThrow: vi.fn(async (): Promise<unknown> => stored),
    create: writer('task.create', (arg: { data: Record<string, unknown> }) => ({ ...arg.data, id: 't2', subtasks: [], recurrence: null })),
    update: writer('task.update', (arg: { data: Record<string, unknown> }) => ({ ...stored, ...arg.data })),
    updateMany: writer('task.updateMany'),
    delete: writer('task.delete'),
  },
  taskCompletion: {
    create: writer('taskCompletion.create', (arg: { data: Record<string, unknown> }) => ({
      id: arg.data.outcome === 'missed' ? 'missed1' : 'done1',
      ...arg.data,
    })),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
    update: writer('taskCompletion.update'),
  },
  taskSubmission: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    create: writer('taskSubmission.create', (arg: { data: Record<string, unknown> }) => ({ id: 's1', ...arg.data })),
    update: writer('taskSubmission.update'),
    count: vi.fn(async () => 0),
  },
  taskPhoto: { create: writer('taskPhoto.create'), deleteMany: writer('taskPhoto.deleteMany') },
  notification: {
    create: writer('notification.create'),
    createMany: writer('notification.createMany'),
    deleteMany: writer('notification.deleteMany'),
  },
  pendingCredit: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    count: vi.fn(async () => 0),
    deleteMany: writer('pendingCredit.deleteMany'),
    createMany: writer('pendingCredit.createMany'),
  },
  pointAward: { createMany: writer('pointAward.createMany'), updateMany: writer('pointAward.updateMany') },
  subtask: {
    update: writer('subtask.update'),
    updateMany: writer('subtask.updateMany'),
    create: writer('subtask.create', (arg: { data: Record<string, unknown> }) => ({ id: 'new', ...arg.data })),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  recurrenceRule: { update: writer('recurrenceRule.update'), create: writer('recurrenceRule.create') },
  user: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => ADULT_ROW),
  },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
};
const prisma = {
  task: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => stored),
    findFirstOrThrow: vi.fn(async (): Promise<unknown> => stored),
  },
  household: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 })) },
  subtask: {
    findFirst: vi.fn(async (): Promise<unknown> => ({ taskId: 't1' })),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    update: writer('subtask.update'),
  },
  taskSubmission: {
    findFirst: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  taskCompletion: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  pointAward: { groupBy: vi.fn(async (): Promise<unknown[]> => []) },
  supervision: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
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
const supervisorsOf = vi.fn(async (): Promise<string[]> => []);
vi.mock('@/server/services/pointsTimeService', () => ({ supervisorsOf }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));
// The JPEG rebuild has its own tests (security/jpeg.test.ts); here it hands back what it was given.
const jpeg = {
  rebuildJpeg: vi.fn((bytes: Uint8Array) => ({ jpeg: bytes, width: 4, height: 3 })),
  PHOTO_MAX_BYTES: 1.5 * 1024 * 1024,
};
vi.mock('@/server/security/jpeg', () => jpeg);

const {
  addSubtask,
  completeTask,
  createTask,
  deleteSubtask,
  deleteTask,
  listTaskCompletions,
  reorderSubtasks,
  resetDueSubtasks,
  rollTaskCycles,
  undoCompletion,
  updateSubtask,
  updateTask,
} = await import('./taskService');
const { UnprocessableError } = await import('./errors');

const H = 'household1';
const NOW = new Date('2026-10-29T15:00:00.000Z');
const SENT = new Date('2026-10-29T13:00:00.000Z');
const QUEUED_AT = new Date('2026-10-29T12:00:00.000Z');
const DAY = 86_400_000;
const kid = { id: 'kid', role: 'child' };
const mum = { id: 'mum', role: 'adult' };
const head = { id: 'boss', role: 'head' };
const LOCKED = 'This is waiting for an adult’s OK. Take it back to change it.';

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

/** A one-time task with two steps worth 1 point each; "a" is ticked. */
function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    householdId: H,
    title: 'Dishes',
    notes: null,
    type: 'one_time',
    priority: 'medium',
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
    categoryId: null,
    roomId: null,
    floorId: null,
    extraRoomIds: [],
    extraFloorIds: [],
    recurrence: null,
    recurrenceId: null,
    photoProof: null,
    updatedAt: QUEUED_AT,
    subtasks: [step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }), step('b', { position: 1 })],
    ...over,
  };
}

/** The check waiting on task t1 from the kid. */
function waiting(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    householdId: H,
    taskId: 't1',
    userId: 'kid',
    kind: 'task',
    status: 'waiting',
    prevStatus: 'in_progress',
    submittedAt: SENT,
    cycleEndsAt: null,
    decidedById: null,
    decidedAt: null,
    ...over,
  };
}

/** The kid is checked: a child whose supervisors (Mum and Dad) turned checks on. */
function checked(over: Record<string, unknown> = {}) {
  tx.user.findFirst.mockResolvedValue({ id: 'kid', role: 'child', reviewTasks: true, name: 'Riley', ...over });
  tx.supervision.findMany.mockResolvedValue([{ supervisor: { role: 'adult' } }]);
  supervisorsOf.mockResolvedValue(['mum', 'dad']);
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

// --- Sending for a check ------------------------------------------------------------

describe('completeTask: who is checked, and what each app is told', () => {
  it('a checked child on an app that can’t send checks: told to update, nothing changed', async () => {
    checked();
    await expect(completeTask(H, kid, { taskId: 't1' })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'Update the Our Home app to send this for a check.',
    });
    expect(writes).toEqual([]);
  });

  it('a checked child completing as before: told it needs a check, nothing changed', async () => {
    checked();
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1 })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'This task now needs a check.',
    });
    expect(writes).toEqual([]);
  });

  it('a check sent by someone no longer checked: told to complete it again, nothing changed', async () => {
    await expect(completeTask(H, mum, { taskId: 't1', checks: 1, forCheck: true })).rejects.toMatchObject({
      message: 'This task doesn’t need a check any more. Tap Complete again.',
    });
    // Checks turned off while the dialog was open.
    checked({ reviewTasks: null });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toThrow(/doesn’t need a check any more/);
    expect(writes).toEqual([]);
  });

  it('a child nobody checks completes as before, whatever their app sends', async () => {
    checked({ reviewTasks: null });
    const out = await completeTask(H, kid, { taskId: 't1', checks: 1 });
    expect(out).toMatchObject({ completionId: 'done1' });
    expect(names()).toContain('pointAward.createMany');
    expect(names()).not.toContain('taskSubmission.create');
  });

  it('a task that asks for a photo checks a supervised child even with checks off', async () => {
    checked({ reviewTasks: null });
    stored = task({ photoProof: true });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1 })).rejects.toThrow('This task now needs a check.');
  });

  it('an adult completes a task that asks for a photo as before', async () => {
    stored = task({ photoProof: true });
    const out = await completeTask(H, mum, { taskId: 't1', checks: 1 });
    expect(out.completionId).toBe('done1');
  });
});

describe('completeTask: sending a task for a check', () => {
  it('records the check, waits, tells each supervisor, logs it without the note, pays nothing', async () => {
    checked();
    const out = await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true, note: 'All done' });
    expect(names()).toEqual([
      'taskSubmission.create',
      'task.update',
      'notification.deleteMany',
      'notification.createMany',
      'logActivity',
    ]);
    expect(written('taskSubmission.create')[0].data).toEqual({
      householdId: H,
      taskId: 't1',
      userId: 'kid',
      kind: 'task',
      note: 'All done',
      submittedAt: NOW,
      prevStatus: 'in_progress',
      cycleStartedAt: null,
      cycleEndsAt: null,
      dueDate: new Date('2026-10-29T17:00:00.000Z'),
      stepIds: ['a'],
      status: 'waiting',
    });
    expect(written('task.update')[0].data).toEqual({ status: 'awaiting_review' });
    expect(written('notification.createMany')[0].data).toEqual(
      ['mum', 'dad'].map((userId) => ({
        householdId: H,
        userId,
        type: 'task_review',
        title: 'Riley sent “Dishes” for a check',
        body: null,
        channel: 'in_app',
        subjectType: 'task',
        subjectId: 't1',
        dedupeKey: `task_review:s1:${userId}`,
        readAt: null,
      })),
    );
    const activity = writes.find(([n]) => n === 'logActivity')![1];
    expect(activity).toEqual({
      householdId: H,
      actorId: 'kid',
      verb: 'updated',
      subjectType: 'task',
      subjectId: 't1',
      message: 'sent “Dishes” for a check',
    });
    expect(JSON.stringify(activity)).not.toContain('All done');
    expect(out).toEqual({
      task: expect.objectContaining({ status: 'awaiting_review' }),
      completionId: null,
      submissionId: 's1',
    });
    // Their phones are woken once it's saved; nobody's turn changed.
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
    expect(ready.pushTaskReady).not.toHaveBeenCalled();
  });

  it('keeps the photo, rebuilt from the base64 sent (a data URL prefix is fine)', async () => {
    checked();
    await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true, photo: 'data:image/jpeg;base64,AQID' });
    expect(jpeg.rebuildJpeg).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(written('taskPhoto.create')[0].data).toEqual({
      householdId: H,
      submissionId: 's1',
      userId: 'kid',
      jpeg: new Uint8Array([1, 2, 3]),
      width: 4,
      height: 3,
      bytes: 3,
    });
  });

  it('refuses a photo that can’t be read before anything is written', async () => {
    checked();
    jpeg.rebuildJpeg.mockImplementationOnce(() => {
      throw new UnprocessableError('That photo couldn’t be read. Take it again.', 'photo');
    });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true, photo: 'AQID' })).rejects.toMatchObject({
      name: 'UnprocessableError',
    });
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a task that asks for a photo takes one, or a note saying why not', async () => {
    checked();
    stored = task({ photoProof: true });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toMatchObject({
      name: 'UnprocessableError',
      field: 'photo',
      message: 'This task needs a photo. Can’t take a photo? Say why in the note.',
    });
    expect(writes).toEqual([]);
    await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true, note: 'Camera broke' });
    expect(written('taskSubmission.create')[0].data).toMatchObject({ note: 'Camera broke' });
  });

  it('a task that doesn’t ask for a photo can be sent with neither', async () => {
    checked();
    await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true });
    expect(written('taskSubmission.create')[0].data).toMatchObject({ note: null });
    expect(names()).not.toContain('taskPhoto.create');
  });

  it('refuses an 11th waiting check the child started, writing nothing', async () => {
    checked();
    tx.taskSubmission.count.mockResolvedValueOnce(10);
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'You have 10 things waiting for an OK. Wait for an adult to check some first.',
    });
    expect(tx.taskSubmission.count).toHaveBeenCalledWith({ where: { householdId: H, userId: 'kid', kind: 'task', status: 'waiting' } });
    expect(writes).toEqual([]);
  });

  it('can’t send or complete a task already waiting', async () => {
    checked();
    stored = task({ status: 'awaiting_review' });
    tx.taskSubmission.findFirst.mockResolvedValue(waiting());
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toThrow('This is waiting for an adult’s OK.');
    await expect(completeTask(H, mum, { taskId: 't1' })).rejects.toThrow('This is waiting for an adult’s OK.');
    expect(writes).toEqual([]);
  });
});

// --- Cycle end ------------------------------------------------------------------------

describe('rollTaskCycles: a check waiting when its cycle ends', () => {
  const CYCLE_START = new Date('2026-10-28T05:00:00.000Z');
  const CYCLE_END = new Date('2026-10-29T05:00:00.000Z');
  const SENT_YESTERDAY = new Date('2026-10-28T23:00:00.000Z');
  const daily = {
    id: 'r1',
    kind: 'daily',
    interval: 1,
    byWeekday: null,
    byMonthday: null,
    cron: null,
    timezone: 'UTC',
    anchorDate: new Date('2026-10-01T17:00:00.000Z'),
    until: null,
    nextRunAt: new Date('2026-10-28T17:00:00.000Z'),
    rollover: true,
    cycleWeekdays: null,
    cycleMonthdays: null,
  };
  const cycleTask = (over: Record<string, unknown> = {}) =>
    task({ type: 'recurring', recurrence: daily, recurrenceId: 'r1', cycleStartedAt: CYCLE_START, cycleEndsAt: CYCLE_END, ...over });

  function rollWith(rule: Record<string, unknown>) {
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    tx.task.findFirst
      .mockResolvedValueOnce(cycleTask({ status: 'awaiting_review', recurrence: rule }))
      .mockResolvedValueOnce(cycleTask({ status: 'in_progress', recurrence: rule }));
    tx.taskSubmission.findFirst.mockResolvedValue(waiting({ submittedAt: SENT_YESTERDAY, cycleEndsAt: CYCLE_END }));
    ready.announceTaskReady.mockResolvedValue('next-person');
    return rollTaskCycles(H, NOW, 't1');
  }

  it('counts it as done as the child sent it, before deciding whether the cycle was missed', async () => {
    checked();
    await rollWith(daily);
    // Paid as sent, then rolled into the new cycle; never recorded as missed.
    expect(written('taskCompletion.create').map((c) => c.data)).toEqual([
      expect.objectContaining({ userId: 'kid', outcome: 'completed', completedAt: SENT_YESTERDAY, recordedAt: NOW, submissionId: 's1' }),
    ]);
    expect(written('pointAward.createMany')[0].data).toEqual([
      expect.objectContaining({ userId: 'kid', subtaskId: 'a', earnedAt: SENT_YESTERDAY, awardedAt: NOW, completionId: 'done1' }),
      expect.objectContaining({ userId: 'kid', subtaskId: 'b', earnedAt: SENT_YESTERDAY, awardedAt: NOW, completionId: 'done1' }),
    ]);
    expect(written('taskSubmission.update')[0]).toEqual({
      where: { id: 's1' },
      data: {
        status: 'auto_approved',
        autoReason: 'cycle_end',
        decidedById: null,
        decidedAt: NOW,
        completionId: 'done1',
        takenBackAt: null,
        photoDeleteAt: new Date(NOW.getTime() + 14 * DAY),
      },
    });
    expect(written('notification.create')[0].data).toMatchObject({
      userId: 'kid',
      type: 'task_reviewed',
      title: 'Counted as done: Dishes',
      dedupeKey: 'task_reviewed:s1',
    });
    // The task first goes back as it was, then is completed, then opens for the new cycle.
    const updates = written('task.update').map((u) => u.data.status);
    expect(updates[0]).toBe('in_progress');
    expect(updates).toContain('completed');
    expect(updates.at(-1)).toBe('pending');
    expect(names().indexOf('taskCompletion.create')).toBeLessThan(names().lastIndexOf('task.update'));
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad', 'kid'] }, 'task');
  });

  it('counts it as done even when the rule’s end date has passed (before that early return)', async () => {
    checked();
    await rollWith({ ...daily, until: new Date('2026-10-28T12:00:00.000Z') });
    expect(written('taskSubmission.update')[0].data).toMatchObject({ status: 'auto_approved', autoReason: 'cycle_end' });
    expect(written('taskCompletion.create').map((c) => c.data.outcome)).toEqual(['completed']);
    // Then it stops cycling, done.
    expect(written('task.update').at(-1)!.data).toEqual({ cycleStartedAt: null, cycleEndsAt: null });
  });

  it('counts it as done even when cycles were switched off (before that early return)', async () => {
    checked();
    await rollWith({ ...daily, rollover: false });
    expect(written('taskSubmission.update')[0].data).toMatchObject({ status: 'auto_approved' });
    expect(written('task.update').at(-1)!.data).toEqual({ cycleStartedAt: null, cycleEndsAt: null });
  });

  it('a child who is gone is never paid: withdrawn, and the cycle is recorded as missed', async () => {
    checked();
    tx.user.findFirst.mockResolvedValue(null);
    await rollWith(daily);
    expect(written('taskSubmission.update')[0]).toEqual({ where: { id: 's1' }, data: { status: 'withdrawn', decidedAt: NOW } });
    expect(written('taskPhoto.deleteMany')[0]).toEqual({ where: { submissionId: 's1' } });
    expect(written('task.updateMany')[0]).toEqual({ where: { id: 't1', status: 'awaiting_review' }, data: { status: 'in_progress' } });
    expect(written('taskCompletion.create').map((c) => c.data)).toEqual([
      { taskId: 't1', userId: null, outcome: 'missed', completedAt: CYCLE_END },
    ]);
    expect(names()).not.toContain('pointAward.createMany');
  });

  it('a child who is now an adult is never paid either', async () => {
    checked({ role: 'adult' });
    await rollWith(daily);
    expect(written('taskSubmission.update')[0].data).toMatchObject({ status: 'withdrawn' });
    expect(names()).not.toContain('pointAward.createMany');
  });

  it('opens a task left waiting with nothing to wait for, then rolls it as unfinished', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    prisma.task.findMany.mockResolvedValueOnce([{ id: 't1' }]);
    tx.task.findFirst.mockResolvedValueOnce(cycleTask({ status: 'awaiting_review' }));
    await rollTaskCycles(H, NOW, 't1');
    expect(writes[0]).toEqual(['task.update', { where: { id: 't1' }, data: { status: 'pending' } }]);
    expect(written('taskCompletion.create').map((c) => c.data.outcome)).toEqual(['missed']);
    warn.mockRestore();
  });
});

// --- Undo -----------------------------------------------------------------------------

describe('undoCompletion of an approved check', () => {
  const APPROVED = new Date(NOW.getTime() - 5 * 60_000);
  const SNAP = JSON.stringify({
    status: 'in_progress', completedAt: null, dueDate: null, nextRunAt: null, cycleStartedAt: null, cycleEndsAt: null,
    opensAt: null, assigneeId: 'kid', steps: [], pending: [],
  });
  const approved = (over: Record<string, unknown> = {}) => waiting({ status: 'approved', decidedById: 'mum', decidedAt: APPROVED, ...over });
  function completion(over: Record<string, unknown> = {}) {
    return {
      id: 'done1',
      taskId: 't1',
      userId: 'kid',
      outcome: 'completed',
      undoneAt: null,
      snapshot: SNAP,
      completedAt: SENT,
      recordedAt: APPROVED,
      submissionId: 's1',
      // A step ticked after it was sent but before the approval was written is no change since.
      task: task({ updatedAt: new Date(APPROVED.getTime() + 1_000), subtasks: [step('a', { done: true, doneAt: new Date(SENT.getTime() + 60_000) })] }),
      ...over,
    };
  }
  function undoAs(actor: { id: string; role: string }, check: unknown = approved()) {
    tx.taskCompletion.findFirst.mockResolvedValueOnce(completion());
    tx.taskSubmission.findFirst.mockResolvedValue(check);
    return undoCompletion(H, actor, 'done1');
  }

  it('the adult who approved it, within 10 minutes: back in To check while the child still needs one', async () => {
    checked();
    const out = await undoAs(mum);
    expect(out.outcome).toBe('back_to_check');
    expect(written('pointAward.updateMany')[0].data).toMatchObject({ voidedById: 'mum', voidReason: 'Completion undone' });
    expect(written('task.update').at(-1)!.data).toMatchObject({ status: 'awaiting_review' });
    expect(written('taskSubmission.update')[0]).toEqual({
      where: { id: 's1' },
      data: { status: 'waiting', decidedById: null, decidedAt: null, completionId: null, photoDeleteAt: null },
    });
    expect(written('notification.createMany')[0].data).toHaveLength(2);
    expect(written('notification.deleteMany')).toContainEqual({ where: { householdId: H, type: 'task_reviewed', dedupeKey: 'task_reviewed:s1' } });
    expect(names()).toContain('clearTaskReady');
    expect(ready.announceTaskReady).not.toHaveBeenCalled();
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['kid', 'mum', 'dad'] }, 'task');
  });

  it('the head, any time; back as it was when the child no longer needs a check', async () => {
    checked({ reviewTasks: null });
    supervisorsOf.mockResolvedValue([]);
    const out = await undoAs(head, approved({ decidedAt: new Date(NOW.getTime() - 3 * DAY) }));
    expect(out.outcome).toBe('undone');
    expect(written('task.update').at(-1)!.data).toMatchObject({ status: 'in_progress' });
    expect(names()).not.toContain('taskSubmission.update');
    expect(ready.announceTaskReady).toHaveBeenCalled();
    // The child's "Approved" row goes.
    expect(written('notification.deleteMany')).toContainEqual({ where: { householdId: H, type: 'task_reviewed', dedupeKey: 'task_reviewed:s1' } });
  });

  it('never the child, even inside their own 10 minutes', async () => {
    checked();
    tx.taskCompletion.findFirst.mockResolvedValueOnce(completion({ completedAt: new Date(NOW.getTime() - 60_000) }));
    tx.taskSubmission.findFirst.mockResolvedValue(approved());
    await expect(undoCompletion(H, kid, 'done1')).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(writes).toEqual([]);
  });

  it('not the approving adult after 10 minutes, nor once they no longer look after the child', async () => {
    checked();
    await expect(undoAs(mum, approved({ decidedAt: new Date(NOW.getTime() - 11 * 60_000) }))).rejects.toThrow(
      /Only the adult who approved this can undo it/,
    );
    supervisorsOf.mockResolvedValue(['dad']);
    await expect(undoAs(mum)).rejects.toThrow(/Only the adult who approved this/);
    expect(writes).toEqual([]);
  });

  it('not another adult who looks after the child but didn’t approve it', async () => {
    checked();
    await expect(undoAs({ id: 'dad', role: 'adult' })).rejects.toMatchObject({ name: 'ForbiddenError' });
  });

  it('never one counted as done on its own, not even by the head', async () => {
    checked();
    await expect(undoAs(head, approved({ status: 'auto_approved', decidedById: null }))).rejects.toMatchObject({
      name: 'ConflictError',
    });
    expect(writes).toEqual([]);
  });

  it('a completion made by hand follows the old rule and reads no check', async () => {
    tx.taskCompletion.findFirst.mockResolvedValueOnce(
      completion({ submissionId: null, userId: 'mum', completedAt: new Date(NOW.getTime() - 60_000), recordedAt: null, task: task({ updatedAt: new Date(NOW.getTime() - 60_000) }) }),
    );
    const out = await undoCompletion(H, mum, 'done1');
    expect(out.outcome).toBe('undone');
    expect(tx.taskSubmission.findFirst).not.toHaveBeenCalled();
  });
});

describe('listTaskCompletions: Undo shown by the same rule', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'done1',
    taskId: 't1',
    userId: 'kid',
    note: null,
    outcome: 'completed',
    undoneAt: null,
    snapshot: '{}',
    completedAt: new Date(NOW.getTime() - 60_000),
    submissionId: 's1',
    user: { id: 'kid', name: 'Riley' },
    ...over,
  });
  async function canUndoFor(actor: { id: string; role: string }, opts: { supervising?: boolean; check?: unknown } = {}) {
    prisma.task.findFirst.mockResolvedValueOnce({ id: 't1' });
    prisma.taskCompletion.findMany.mockResolvedValueOnce([row(), row({ id: 'old', submissionId: null, userId: 'mum' })]);
    prisma.pointAward.groupBy.mockResolvedValueOnce([]);
    prisma.taskSubmission.findMany.mockResolvedValueOnce([
      opts.check ?? waiting({ status: 'approved', decidedById: 'mum', decidedAt: new Date(NOW.getTime() - 60_000) }),
    ]);
    prisma.supervision.findMany.mockResolvedValueOnce(
      opts.supervising === false ? [] : [{ supervisedId: 'kid', supervisor: { role: 'adult' }, supervised: { role: 'child' } }],
    );
    return (await listTaskCompletions(H, 't1', actor)).map((c) => c.canUndo);
  }

  it('the approving adult while they look after the child, and the head', async () => {
    expect(await canUndoFor(mum)).toEqual([true, false]);
    expect(await canUndoFor(head)).toEqual([true, false]);
  });

  it('not the child, another adult, the approver once removed, or one counted as done', async () => {
    expect(await canUndoFor(kid)).toEqual([false, false]);
    expect(await canUndoFor({ id: 'dad', role: 'adult' })).toEqual([false, false]);
    expect(await canUndoFor(mum, { supervising: false })).toEqual([false, false]);
    expect(await canUndoFor(head, { check: waiting({ status: 'auto_approved' }) })).toEqual([false, false]);
  });
});

// --- While a task waits ------------------------------------------------------------------

describe('updateTask while a task waits for its check', () => {
  const waitingTask = (over: Record<string, unknown> = {}) => task({ status: 'awaiting_review', ...over });
  /** What the web editor sends for the task as stored: every field, every step `done: false`. */
  const webSave = (over: Record<string, unknown> = {}) => ({
    taskId: 't1',
    title: 'Dishes',
    type: 'one_time' as const,
    priority: 'medium' as const,
    notes: undefined,
    dueDate: new Date('2026-10-29T17:00:00.000Z'),
    estimatedMinutes: 20,
    points: null,
    pointsFollowTime: true,
    categoryId: null,
    roomIds: [],
    floorIds: [],
    assigneeId: 'kid',
    rotationUserIds: [],
    subtasks: ['a', 'b'].map((id) => ({
      id,
      title: `Step ${id}`,
      done: false,
      resetIntervalDays: null,
      minutes: 10,
      points: 1,
      minutesCustom: false,
      pointsFollowTime: true,
    })),
    recurrence: null,
    ...over,
  });
  beforeEach(() => {
    stored = waitingTask();
    tx.taskSubmission.findFirst.mockResolvedValue(waiting());
  });

  it('a new title from the web form (all steps done: false) is saved, and the ticks stay as they were', async () => {
    await updateTask(H, 'mum', webSave({ title: 'Dishes and pans' }));
    expect(names()).toEqual(['task.update', 'logActivity']);
    expect(written('task.update')[0].data).toMatchObject({ title: 'Dishes and pans', status: undefined, dueDate: undefined });
  });

  it('a renamed step is saved on its own; nothing else about the checklist is written', async () => {
    const save = webSave();
    save.subtasks[1].title = 'Dry';
    await updateTask(H, 'mum', save);
    expect(writes[0]).toEqual(['subtask.update', { where: { id: 'b' }, data: { title: 'Dry' } }]);
    expect(names()).toEqual(['subtask.update', 'task.update', 'logActivity']);
  });

  it('an unchanged recurring task with cycles, after a completion moved nextRunAt, is left exactly as it was', async () => {
    const rule = {
      id: 'r1', kind: 'daily', interval: 1, byWeekday: null, byMonthday: null, cron: null, timezone: 'UTC',
      anchorDate: new Date('2026-10-01T17:00:00.000Z'), until: null, nextRunAt: new Date('2026-11-05T17:00:00.000Z'),
      rollover: true, cycleWeekdays: null, cycleMonthdays: null,
    };
    stored = waitingTask({
      type: 'recurring', recurrence: rule, recurrenceId: 'r1',
      cycleStartedAt: new Date('2026-10-29T05:00:00.000Z'), cycleEndsAt: new Date('2026-10-30T05:00:00.000Z'),
    });
    await updateTask(
      H,
      'mum',
      webSave({
        type: 'recurring',
        recurrence: { kind: 'daily', interval: 1, timezone: 'UTC', until: null, rollover: true, cycleWeekdays: null, cycleMonthdays: null },
      }),
    );
    // No rule rewrite (its anchor and next run stay), no new cycle, no type change.
    expect(names()).toEqual(['task.update', 'logActivity']);
    const data = written('task.update')[0].data;
    expect(data.type).toBeUndefined();
    expect(data).not.toHaveProperty('cycleStartedAt');
  });

  it('refuses a change to a step’s points, writing nothing', async () => {
    const save = webSave();
    save.subtasks[0].points = 2;
    await expect(updateTask(H, 'mum', save)).rejects.toMatchObject({ name: 'ConflictError', message: LOCKED });
    expect(writes).toEqual([]);
  });

  it('refuses a new step, a removed step and a step from another task', async () => {
    const added = webSave();
    added.subtasks.push({ ...added.subtasks[0], id: undefined as unknown as string, title: 'New' });
    await expect(updateTask(H, 'mum', added)).rejects.toThrow(LOCKED);
    const removed = webSave();
    removed.subtasks.pop();
    await expect(updateTask(H, 'mum', removed)).rejects.toThrow(LOCKED);
    const foreign = webSave();
    foreign.subtasks[1].id = 'other-task-step';
    await expect(updateTask(H, 'mum', foreign)).rejects.toThrow(LOCKED);
    const moved = webSave();
    moved.subtasks.reverse();
    await expect(updateTask(H, 'mum', moved)).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
  });

  it('refuses a new status, due date, assignee, priority or points, writing nothing', async () => {
    for (const change of [
      { status: 'pending' as const },
      { status: 'archived' as const },
      { dueDate: new Date('2026-10-30T17:00:00.000Z') },
      { assigneeId: 'mum' },
      { priority: 'high' as const },
      { estimatedMinutes: 30 },
      { recurrence: { kind: 'daily' as const, interval: 1, timezone: 'UTC' } },
    ]) {
      await expect(updateTask(H, 'mum', webSave(change))).rejects.toThrow(LOCKED);
    }
    expect(writes).toEqual([]);
  });

  it('refuses any change from the child who sent it; their unchanged save is fine', async () => {
    tx.user.findFirst.mockResolvedValue({ id: 'kid', role: 'child', reviewTasks: true, name: 'Riley' });
    await expect(updateTask(H, 'kid', webSave({ title: 'Done!' }))).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
    await updateTask(H, 'kid', webSave());
    expect(names()).toEqual(['task.update', 'logActivity']);
  });

  it('refuses switching "Ask for a photo" while it waits', async () => {
    await expect(updateTask(H, 'mum', webSave({ photoProof: true }))).rejects.toThrow(LOCKED);
  });
});

describe('Ask for a photo (photoProof)', () => {
  it('a supervised child can’t turn it on for a new task (403), writing nothing', async () => {
    checked();
    await expect(createTask(H, 'kid', { title: 'Room', type: 'one_time', priority: 'medium', photoProof: true })).rejects.toMatchObject({
      name: 'ForbiddenError',
      field: 'photoProof',
    });
    expect(writes).toEqual([]);
  });

  it('an adult turns it on for a new task; off is stored as null', async () => {
    await createTask(H, 'mum', { title: 'Room', type: 'one_time', priority: 'medium', photoProof: true });
    expect(written('task.create')[0].data).toMatchObject({ photoProof: true });
    writes.length = 0;
    await createTask(H, 'mum', { title: 'Room', type: 'one_time', priority: 'medium' });
    expect(written('task.create')[0].data).toMatchObject({ photoProof: null });
  });

  it('a supervised child can’t change it on a task any time (403); sending it unchanged is fine', async () => {
    checked();
    await expect(updateTask(H, 'kid', { taskId: 't1', photoProof: true })).rejects.toMatchObject({ name: 'ForbiddenError' });
    stored = task({ photoProof: true });
    await expect(updateTask(H, 'kid', { taskId: 't1', photoProof: false })).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(writes).toEqual([]);
    await updateTask(H, 'kid', { taskId: 't1', title: 'Dishes', photoProof: true });
    expect(names()).toContain('task.update');
  });

  it('an adult changes it', async () => {
    await updateTask(H, 'mum', { taskId: 't1', photoProof: true });
    expect(written('task.update').at(-1)!.data).toMatchObject({ photoProof: true });
  });
});

describe('steps while a task waits', () => {
  beforeEach(() => {
    stored = task({ status: 'awaiting_review' });
    tx.taskSubmission.findFirst.mockResolvedValue(waiting());
    prisma.taskSubmission.findFirst.mockResolvedValue(waiting());
  });

  it('can’t be ticked or unticked', async () => {
    await expect(updateSubtask(H, { subtaskId: 'a', done: false }, kid)).rejects.toThrow(LOCKED);
    await expect(updateSubtask(H, { subtaskId: 'b', done: true }, mum)).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
  });

  it('can’t be added or removed', async () => {
    await expect(addSubtask(H, { taskId: 't1', title: 'More' })).rejects.toThrow(LOCKED);
    await expect(deleteSubtask(H, 'b')).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
  });

  it('can be renamed, but not moved or given a new reset; the same values are fine', async () => {
    await updateSubtask(H, { subtaskId: 'b', title: 'Dry' }, mum);
    expect(writes).toEqual([['subtask.update', { where: { id: 'b' }, data: { title: 'Dry', resetIntervalDays: undefined } }]]);
    writes.length = 0;
    await expect(updateSubtask(H, { subtaskId: 'b', position: 0 }, mum)).rejects.toThrow(LOCKED);
    await expect(updateSubtask(H, { subtaskId: 'b', resetIntervalDays: 2 }, mum)).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
    await updateSubtask(H, { subtaskId: 'b', title: 'Step b', resetIntervalDays: null }, mum);
  });

  it('the child who sent it can’t rename one', async () => {
    await expect(updateSubtask(H, { subtaskId: 'b', title: 'Dry' }, kid)).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
  });

  it('can’t be reordered; the same order is fine', async () => {
    tx.subtask.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    await expect(reorderSubtasks(H, { taskId: 't1', subtaskIds: ['b', 'a'] })).rejects.toThrow(LOCKED);
    expect(writes).toEqual([]);
    await reorderSubtasks(H, { taskId: 't1', subtaskIds: ['a', 'b'] });
  });

  it('deleting the task removes its checks’ bell rows (the checks and photos cascade)', async () => {
    stored = { id: 't1', title: 'Dishes', recurrenceId: null };
    await deleteTask(H, 'mum', 't1');
    expect(written('notification.deleteMany')).toContainEqual({
      where: { householdId: H, subjectId: 't1', type: { in: ['task_review', 'task_reviewed'] } },
    });
    expect(names().indexOf('notification.deleteMany')).toBeLessThan(names().indexOf('task.delete'));
  });

  it('are never reset by their own cadence while it waits', async () => {
    await resetDueSubtasks(H);
    expect(prisma.subtask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ task: { householdId: H, status: { not: 'awaiting_review' } } }) }),
    );
  });
});
