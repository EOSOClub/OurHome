import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

// Task Photo Proof, the "steps" kind: step points that would be paid without
// a check wait in one "steps" check per task and child instead. A re-tick
// paid at once (pay_now) and a completion by someone who doesn't look after
// the child both make entries; an adult approves or sends them back; undo,
// settle and a hand-uncheck each treat them by the spec's rules. Checks live
// in a small in-memory store so a flow can be followed across calls; every
// other write is recorded in order, as in taskServiceChecks.test.ts.

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

// --- Checks (TaskSubmission), kept in memory --------------------------------------
type Sub = Record<string, unknown> & { id: string };
let subs: Sub[] = [];
type Where = Record<string, unknown>;
function matches(row: Sub, where: Where): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'householdId') return true;
    if (want && typeof want === 'object' && 'contains' in want) return String(row[key] ?? '').includes(String(want.contains));
    if (want && typeof want === 'object' && 'in' in want) return (want.in as unknown[]).includes(row[key]);
    return row[key] === want;
  });
}
const submissions = {
  findFirst: vi.fn(async ({ where }: { where: Where }) => subs.find((s) => matches(s, where)) ?? null),
  findMany: vi.fn(async ({ where }: { where: Where }) => subs.filter((s) => matches(s, where))),
  count: vi.fn(async ({ where }: { where: Where }) => subs.filter((s) => matches(s, where)).length),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    // The unique index on waitingKey, as Mongo enforces it.
    if (subs.some((s) => s.waitingKey === data.waitingKey)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: `TaskSubmission_waitingKey_key`', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'TaskSubmission_waitingKey_key' },
      });
    }
    writes.push(['taskSubmission.create', { data }]);
    const row = { id: `new${subs.length + 1}`, ...data };
    subs.push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    writes.push(['taskSubmission.update', { where, data }]);
    const row = subs.find((s) => s.id === where.id)!;
    Object.assign(row, data);
    return row;
  }),
};

// --- People: who is checked, and who looks after whom -------------------------------
const PEOPLE: Record<string, { id: string; role: string; reviewTasks: boolean | null; name: string }> = {
  kid: { id: 'kid', role: 'child', reviewTasks: true, name: 'Riley' },
  mum: { id: 'mum', role: 'adult', reviewTasks: null, name: 'Mum' },
  dad: { id: 'dad', role: 'adult', reviewTasks: null, name: 'Dad' },
  sam: { id: 'sam', role: 'teen', reviewTasks: null, name: 'Sam' },
  boss: { id: 'boss', role: 'head', reviewTasks: null, name: 'Boss' },
};
let people: typeof PEOPLE = {};
let lookAfter: Record<string, string[]> = {};

let stored: Record<string, unknown> = {};
let pendingRow: unknown = null;
let pendingRows: unknown[] = [];
let awardNo = 0;
const tx = {
  task: {
    findFirst: vi.fn(async (): Promise<unknown> => stored),
    findFirstOrThrow: vi.fn(async (): Promise<unknown> => stored),
    update: writer('task.update', (arg: { data: Record<string, unknown> }) => ({ ...stored, ...arg.data })),
    updateMany: writer('task.updateMany'),
  },
  taskCompletion: {
    create: writer('taskCompletion.create', (arg: { data: Record<string, unknown> }) => ({ id: 'done1', ...arg.data })),
    findFirst: vi.fn(async (): Promise<unknown> => null),
    count: vi.fn(async () => 0),
    update: writer('taskCompletion.update'),
  },
  taskSubmission: submissions,
  taskPhoto: { deleteMany: writer('taskPhoto.deleteMany') },
  notification: {
    create: writer('notification.create'),
    createMany: writer('notification.createMany'),
    deleteMany: writer('notification.deleteMany'),
  },
  pendingCredit: {
    findUnique: vi.fn(async (): Promise<unknown> => pendingRow),
    findMany: vi.fn(async (): Promise<unknown[]> => pendingRows),
    count: vi.fn(async () => 0),
    create: writer('pendingCredit.create'),
    delete: writer('pendingCredit.delete'),
    deleteMany: writer('pendingCredit.deleteMany'),
    createMany: writer('pendingCredit.createMany'),
  },
  pointAward: {
    create: writer('pointAward.create', (arg: { data: Record<string, unknown> }) => ({ id: `award${++awardNo}`, ...arg.data })),
    createMany: writer('pointAward.createMany'),
    updateMany: writer('pointAward.updateMany'),
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findMany: vi.fn(async (): Promise<unknown[]> => []),
  },
  subtask: { update: writer('subtask.update'), updateMany: writer('subtask.updateMany') },
  recurrenceRule: { update: writer('recurrenceRule.update') },
  user: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => people[where.id] ?? null) },
  supervision: {
    findMany: vi.fn(async ({ where }: { where: { supervisedId: string } }) =>
      (lookAfter[where.supervisedId] ?? []).map((id) => ({ supervisor: { role: people[id]?.role ?? 'adult' } })),
    ),
  },
};
const prisma = {
  task: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(async (): Promise<unknown> => stored),
  },
  household: { findUnique: vi.fn(async () => ({ timezone: 'America/Chicago', weekStartsOn: 0, minutesPerPoint: 10 })) },
  subtask: { findFirst: vi.fn(async (): Promise<unknown> => ({ taskId: 't1' })) },
  taskSubmission: submissions,
  taskPhoto: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  user: {
    findMany: vi.fn(async () => Object.values(people).map((p) => ({ id: p.id, name: p.name }))),
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => people[where.id] ?? null),
  },
  // Read for the member a task DTO is for: by child (needsCheck) or by adult (supervisedNow).
  supervision: {
    findMany: vi.fn(async ({ where }: { where: { supervisedId?: string; supervisorId?: string } }) =>
      where.supervisedId !== undefined
        ? (lookAfter[where.supervisedId] ?? []).map((id) => ({ supervisor: { role: people[id]?.role ?? 'adult' } }))
        : Object.entries(lookAfter)
            .filter(([, adults]) => adults.includes(where.supervisorId!))
            .map(([childId]) => ({
              supervisedId: childId,
              supervisor: { role: people[where.supervisorId!]?.role ?? 'adult' },
              supervised: { role: people[childId]?.role ?? 'child' },
            })),
    ),
  },
  pendingCredit: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  floor: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  room: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
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
const supervisorsOf = vi.fn(async (_db: unknown, _hh: string, childId: string): Promise<string[]> => lookAfter[childId] ?? []);
vi.mock('@/server/services/pointsTimeService', () => ({ supervisorsOf }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));

const { completeInTx, completeTask, taskDTO, taskDTOs, undoCompletion, updateSubtask } = await import('./taskService');
const { decideSubmission, settleOrphanedSubmissions, withdrawSubmission } = await import('./taskSubmissionService');
const { settingsFrom } = await import('./pointsService');

const H = 'household1';
const NOW = new Date('2026-10-29T15:00:00.000Z');
const QUEUED_AT = new Date('2026-10-29T12:00:00.000Z');
const RESET_AT = new Date('2026-10-29T13:00:00.000Z');
const TICK = new Date('2026-10-29T14:00:00.000Z');
const EARLIER = new Date('2026-10-28T14:00:00.000Z');
const kid = { id: 'kid', role: 'child' };
const mum = { id: 'mum', role: 'adult' };
const sam = { id: 'sam', role: 'teen' };
const boss = { id: 'boss', role: 'head' };
const UNTICKED = { done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null };
const TOO_MANY = 'You have 10 things waiting for an OK. Wait for an adult to check some first.';

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  taskId: 't1',
  title: `Step ${id}`,
  done: false,
  doneAt: null,
  doneById: null,
  checkAwardId: null,
  autoResetAt: null,
  resetIntervalDays: 1,
  minutes: 10,
  pointsCenti: 100,
  minutesCustom: false,
  pointsFollowTime: true,
  position: 0,
  ...over,
});

/** A one-time task with two steps worth 1 point each; "a" ticked and queued by the kid. */
function task(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    householdId: H,
    createdById: 'mum',
    title: 'Dishes',
    notes: null,
    type: 'one_time',
    priority: 'medium',
    status: 'in_progress',
    dueDate: null,
    completedAt: null,
    createdAt: QUEUED_AT,
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
    category: null,
    roomId: null,
    room: null,
    floorId: null,
    floor: null,
    extraRoomIds: [],
    extraFloorIds: [],
    assignee: null,
    position: null,
    recurrence: null,
    photoProof: null,
    updatedAt: QUEUED_AT,
    subtasks: [step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }), step('b', { position: 1 })],
    ...over,
  };
}
const queued = (subtaskId: string, userId = 'kid', checkedAt = QUEUED_AT) => ({
  id: `pc-${subtaskId}`,
  householdId: H,
  taskId: 't1',
  subtaskId,
  userId,
  checkedAt,
  cycleStartedAt: null,
});
const entry = (subtaskId: string, checkedAt: Date, over: Record<string, unknown> = {}) => ({
  subtaskId,
  title: `Step ${subtaskId}`,
  pointsCenti: 100,
  checkedAt: checkedAt.toISOString(),
  awardKind: 'step_repeat',
  ...over,
});
/** A waiting "steps" check from the kid on t1 holding [entries]. */
function stepsCheck(entries: unknown[], over: Record<string, unknown> = {}): Sub {
  const row: Sub = {
    id: 's9',
    householdId: H,
    taskId: 't1',
    userId: 'kid',
    kind: 'steps',
    status: 'waiting',
    prevStatus: null,
    submittedAt: EARLIER,
    entries: JSON.stringify(entries),
    ...over,
  };
  return { ...row, waitingKey: row.status === 'waiting' ? `steps:${String(row.taskId)}:${String(row.userId)}` : row.id };
}
/** [n] waiting "task" checks the kid sent on other tasks. */
const sends = (n: number): Sub[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t-send${i}`, taskId: `other${i}`, userId: 'kid', kind: 'task', status: 'waiting', waitingKey: `task:other${i}`,
  }));
const entriesOf = (id: string) => JSON.parse(String(subs.find((s) => s.id === id)!.entries)) as Record<string, unknown>[];

beforeEach(() => {
  vi.resetAllMocks();
  writes.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  people = { ...PEOPLE };
  lookAfter = { kid: ['mum', 'dad'] };
  subs = [];
  stored = task();
  pendingRow = null;
  pendingRows = [];
  awardNo = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

// --- (a) A step ticked again ---------------------------------------------------------

describe('a checked child ticking a step again (pay_now): waits for an OK instead', () => {
  /** "a" was queued by the kid, then reset on its own; now ticked again. */
  const reticked = (over: Record<string, unknown> = {}) =>
    task({ subtasks: [step('a', { autoResetAt: RESET_AT }), step('b', { position: 1 })], ...over });

  it('queued this cycle: one tap ticks it, and its points go to a new steps check, not paid', async () => {
    stored = reticked();
    pendingRow = queued('a');
    const allow = vi.fn(() => true);
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid, { allowCheck: allow });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(names()).not.toContain('pointAward.create');
    expect(written('subtask.update')).toEqual([
      { where: { id: 'a' }, data: { done: true, doneAt: NOW, doneById: 'kid', checkAwardId: null, autoResetAt: null } },
    ]);
    expect(subs).toEqual([
      expect.objectContaining({ householdId: H, taskId: 't1', userId: 'kid', kind: 'steps', status: 'waiting', submittedAt: NOW, waitingKey: 'steps:t1:kid' }),
    ]);
    expect(entriesOf(subs[0].id)).toEqual([entry('a', NOW)]);
    expect(written('notification.createMany')[0].data).toEqual(
      ['mum', 'dad'].map((userId) =>
        expect.objectContaining({ userId, type: 'task_review', title: 'Riley’s steps on “Dishes” need a check', dedupeKey: `task_review:new1:${userId}` }),
      ),
    );
    expect(allow).toHaveBeenCalledTimes(1);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
  });

  it('on a finished task: the same', async () => {
    stored = reticked({ status: 'completed' });
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(names()).not.toContain('pointAward.create');
    expect(entriesOf(subs[0].id)).toEqual([entry('a', NOW)]);
  });

  it('anyone not checked is paid at once, as before, and never limited', async () => {
    for (const actor of [mum, sam]) {
      writes.length = 0;
      stored = reticked();
      pendingRow = queued('a');
      const allow = vi.fn(() => true);
      await updateSubtask(H, { subtaskId: 'a', done: true }, actor, { allowCheck: allow });
      expect(written('pointAward.create')[0].data).toMatchObject({ userId: actor.id, kind: 'step_repeat', subtaskId: 'a', pointsCenti: 100, earnedAt: NOW, awardedAt: NOW });
      expect(written('subtask.update')[0].data).toMatchObject({ done: true, checkAwardId: expect.stringMatching(/^award/) });
      expect(allow).not.toHaveBeenCalled();
    }
    expect(subs).toEqual([]);
  });

  it('adds to the child’s waiting steps check, never a second one, and replaces the supervisors’ rows', async () => {
    subs = [stepsCheck([entry('b', EARLIER)])];
    stored = reticked();
    pendingRow = queued('a');
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(subs).toHaveLength(1);
    expect(names()).not.toContain('taskSubmission.create');
    expect(entriesOf('s9')).toEqual([entry('b', EARLIER), entry('a', NOW)]);
    expect(written('notification.deleteMany')).toEqual([
      { where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s9:' } } },
    ]);
    expect(written('notification.createMany')[0].data).toHaveLength(2);
  });

  it('a first tick is queued as before: no check, no limit', async () => {
    stored = task({ subtasks: [step('a'), step('b', { position: 1 })] });
    const allow = vi.fn(() => true);
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid, { allowCheck: allow });
    expect(written('pendingCredit.create')[0].data).toMatchObject({ userId: 'kid', subtaskId: 'a', checkedAt: NOW });
    expect(subs).toEqual([]);
    expect(allow).not.toHaveBeenCalled();
  });
});

describe('the cap of 10 and the per-user limit on re-ticks', () => {
  const reticked = () => task({ subtasks: [step('a', { autoResetAt: RESET_AT }), step('b', { position: 1 })] });
  beforeEach(() => {
    stored = reticked();
    pendingRow = queued('a');
  });

  it('a re-tick that would start an 11th check of their own is refused (409), nothing written', async () => {
    subs = sends(10);
    await expect(updateSubtask(H, { subtaskId: 'a', done: true }, kid)).rejects.toMatchObject({ name: 'ConflictError', message: TOO_MANY });
    expect(writes).toEqual([]);
    // Re-ticks count as checks they started: 9 sends and a re-ticked steps check are 10.
    subs = [...sends(9), stepsCheck([entry('b', EARLIER)], { id: 's8', taskId: 'other' })];
    await expect(updateSubtask(H, { subtaskId: 'a', done: true }, kid)).rejects.toThrow(TOO_MANY);
    // Sending a whole task counts them too.
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toThrow(TOO_MANY);
    expect(writes).toEqual([]);
  });

  it('that refusal carries the code check_cap, as a send does', async () => {
    subs = sends(10);
    await expect(updateSubtask(H, { subtaskId: 'a', done: true }, kid)).rejects.toMatchObject({ message: TOO_MANY, code: 'check_cap' });
  });

  it('adding to a check that already counts never makes another; entries from someone else’s completion never count', async () => {
    subs = [...sends(9), stepsCheck([entry('b', EARLIER)])];
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(entriesOf('s9')).toHaveLength(2);
    // Nine sends and a check holding only a sibling's completion's entries: room for one more.
    subs = [...sends(9), stepsCheck([entry('b', QUEUED_AT, { awardKind: 'step', completionId: 'c7' })], { id: 's8', taskId: 'other' })];
    writes.length = 0;
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(names()).toContain('taskSubmission.create');
  });

  it('past the per-user limit: 429, nothing written', async () => {
    await expect(updateSubtask(H, { subtaskId: 'a', done: true }, kid, { allowCheck: () => false })).rejects.toMatchObject({
      name: 'TooManyRequestsError',
      message: 'That’s a lot of checks at once. Wait a minute, then try again.',
    });
    expect(writes).toEqual([]);
  });
});

// --- (b) Someone else completes the task ---------------------------------------------

describe('a completion by someone who doesn’t look after a checked child', () => {
  beforeEach(() => {
    pendingRows = [queued('a')];
  });

  it('keeps the child’s queued steps out of the payout entirely (never paid to the completer) and sends them for a check', async () => {
    await completeTask(H, sam, { taskId: 't1' });
    // Only "b", the step nobody queued, is paid, to Sam.
    expect(written('pointAward.createMany')[0].data).toEqual([expect.objectContaining({ userId: 'sam', subtaskId: 'b', pointsCenti: 100 })]);
    expect(subs).toEqual([expect.objectContaining({ userId: 'kid', kind: 'steps', status: 'waiting' })]);
    expect(entriesOf(subs[0].id)).toEqual([entry('a', QUEUED_AT, { awardKind: 'step', completionId: 'done1' })]);
    expect(written('logActivity').at(-1)).toMatchObject({ actorId: 'sam', message: 'completed task “Dishes” (1 pts)' });
    // Still undone later: the snapshot keeps the queued points.
    expect(JSON.parse(String(written('taskCompletion.create')[0].data.snapshot)).pending).toEqual([
      expect.objectContaining({ subtaskId: 'a', userId: 'kid' }),
    ]);
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
  });

  it('when every step was the child’s, nobody is paid anything now', async () => {
    stored = task({ subtasks: [step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }), step('b', { position: 1, done: true, doneAt: QUEUED_AT, doneById: 'kid' })] });
    pendingRows = [queued('a'), queued('b')];
    await completeTask(H, boss, { taskId: 't1' });
    expect(names()).not.toContain('pointAward.createMany');
    expect(entriesOf(subs[0].id).map((e) => e.subtaskId)).toEqual(['a', 'b']);
  });

  it('is never refused by the cap: the server made these entries', async () => {
    subs = sends(10);
    await completeTask(H, sam, { taskId: 't1' });
    expect(subs.filter((s) => s.kind === 'steps')).toHaveLength(1);
  });

  it('the check keeps that the task asked for a photo, so turning it off later never lets settle pay it', async () => {
    stored = task({ photoProof: true });
    await completeTask(H, sam, { taskId: 't1' });
    expect(subs).toEqual([expect.objectContaining({ userId: 'kid', kind: 'steps', status: 'waiting', photoProof: true })]);
    // "Ask for a photo" off, checks off; Mum and Dad still look after the kid.
    stored = { ...stored, photoProof: null };
    people.kid = { ...PEOPLE.kid, reviewTasks: null };
    writes.length = 0;
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(0);
    expect(writes).toEqual([]);
    expect(subs[0]).toMatchObject({ status: 'waiting' });
  });

  it('a completion by one of the child’s supervisors pays them as today', async () => {
    await completeTask(H, mum, { taskId: 't1' });
    expect(written('pointAward.createMany')[0].data).toEqual([
      expect.objectContaining({ userId: 'kid', subtaskId: 'a', earnedAt: QUEUED_AT }),
      expect.objectContaining({ userId: 'mum', subtaskId: 'b' }),
    ]);
    expect(subs).toEqual([]);
  });

  it('the child’s own approved check pays them as today', async () => {
    const settings = settingsFrom({ timezone: 'America/Chicago', minutesPerPoint: 10 });
    await completeInTx(tx as never, { householdId: H, completer: kid, input: { taskId: 't1' }, settings, at: QUEUED_AT, now: NOW, submissionId: 's1' });
    expect(written('pointAward.createMany')[0].data).toEqual([
      expect.objectContaining({ userId: 'kid', subtaskId: 'a' }),
      expect.objectContaining({ userId: 'kid', subtaskId: 'b' }),
    ]);
    expect(subs).toEqual([]);
  });

  it('a child nobody checks is paid as today, whoever completes it', async () => {
    people.kid = { ...PEOPLE.kid, reviewTasks: null };
    await completeTask(H, sam, { taskId: 't1' });
    expect(written('pointAward.createMany')[0].data).toEqual([
      expect.objectContaining({ userId: 'kid', subtaskId: 'a' }),
      expect.objectContaining({ userId: 'sam', subtaskId: 'b' }),
    ]);
  });
});

// --- Unticking a step whose tick waits ------------------------------------------------

describe('unticking a step whose current tick waits for an OK', () => {
  beforeEach(() => {
    stored = task({ subtasks: [step('a', { done: true, doneAt: TICK, doneById: 'kid' }), step('b', { position: 1 })] });
    pendingRow = queued('a');
  });

  it('the child, a supervisor or the head: that tick leaves the check, ticking again counts, queued points stay', async () => {
    for (const actor of [kid, mum, boss]) {
      writes.length = 0;
      subs = [stepsCheck([entry('a', EARLIER), entry('a', TICK)])];
      await updateSubtask(H, { subtaskId: 'a', done: false }, actor);
      // The earlier tick's entry stays.
      expect(entriesOf('s9')).toEqual([entry('a', EARLIER)]);
      expect(written('subtask.update')).toEqual([{ where: { id: 'a' }, data: { ...UNTICKED, autoResetAt: NOW } }]);
      expect(names()).not.toContain('pendingCredit.delete');
    }
  });

  it('a check left empty is withdrawn and its rows go', async () => {
    subs = [stepsCheck([entry('a', TICK)])];
    await updateSubtask(H, { subtaskId: 'a', done: false }, kid);
    expect(subs[0]).toMatchObject({ status: 'withdrawn', decidedAt: NOW, waitingKey: 's9' });
    expect(written('notification.deleteMany')).toContainEqual({
      where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s9:' } },
    });
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
  });

  it('anyone else (a sibling): unticked, but the entry stays and ticking again doesn’t count', async () => {
    subs = [stepsCheck([entry('a', TICK)])];
    await updateSubtask(H, { subtaskId: 'a', done: false }, sam);
    expect(subs[0]).toMatchObject({ status: 'waiting' });
    expect(entriesOf('s9')).toEqual([entry('a', TICK)]);
    expect(written('subtask.update')).toEqual([{ where: { id: 'a' }, data: { ...UNTICKED, autoResetAt: null } }]);
    expect(names()).not.toContain('pendingCredit.delete');
  });

  it('only the current tick: an entry for an earlier one leaves the uncheck as it always was', async () => {
    subs = [stepsCheck([entry('a', EARLIER)])];
    await updateSubtask(H, { subtaskId: 'a', done: false }, kid);
    expect(entriesOf('s9')).toEqual([entry('a', EARLIER)]);
    expect(written('pendingCredit.delete')).toEqual([{ where: { id: 'pc-a' } }]);
    expect(written('subtask.update')).toEqual([{ where: { id: 'a' }, data: { ...UNTICKED, autoResetAt: null } }]);
  });
});

// --- Deciding a steps check --------------------------------------------------------------

describe('decideSubmission on a steps check', () => {
  const TICK_B = new Date('2026-10-29T14:30:00.000Z');
  beforeEach(() => {
    // "a" still ticked from its waiting repeat; "b" ticked again since its repeat in the check.
    stored = task({
      subtasks: [step('a', { done: true, doneAt: TICK, doneById: 'kid' }), step('b', { position: 1, done: true, doneAt: TICK_B, doneById: 'kid' })],
    });
    subs = [stepsCheck([entry('a', TICK), entry('b', EARLIER), entry('b', QUEUED_AT, { awardKind: 'step', completionId: 'c7' })])];
  });

  it('approve pays each entry as of its tick, landing now; a repeat still ticked becomes the step’s paid check', async () => {
    const out = await decideSubmission(H, mum, { submissionId: 's9', decision: 'approve' });
    expect(out).toEqual({ taskId: 't1', completionId: null });
    const base = { householdId: H, userId: 'kid', taskId: 't1', taskTitle: 'Dishes', pointsCenti: 100, awardedAt: NOW };
    expect(written('pointAward.create').map((c) => c.data)).toEqual([
      { ...base, subtaskId: 'a', completionId: null, kind: 'step_repeat', stepTitle: 'Step a', earnedAt: TICK },
      { ...base, subtaskId: 'b', completionId: null, kind: 'step_repeat', stepTitle: 'Step b', earnedAt: EARLIER },
      { ...base, subtaskId: 'b', completionId: 'c7', kind: 'step', stepTitle: 'Step b', earnedAt: QUEUED_AT },
    ]);
    // Only "a" is still ticked from the tick it was for.
    expect(written('subtask.update')).toEqual([{ where: { id: 'a' }, data: { checkAwardId: 'award1' } }]);
    expect(subs[0]).toMatchObject({ status: 'approved', decidedById: 'mum', decidedAt: NOW, waitingKey: 's9' });
    expect(written('notification.deleteMany')).toContainEqual({
      where: { householdId: H, type: 'task_review', dedupeKey: { startsWith: 'task_review:s9:' } },
    });
    expect(written('notification.create')[0].data).toMatchObject({
      userId: 'kid',
      type: 'task_reviewed',
      title: 'Approved: steps on Dishes (+3 pts)',
      body: null,
      dedupeKey: 'task_reviewed:s9',
    });
    // The task itself never changes.
    expect(names()).not.toContain('task.update');
    expect(names()).not.toContain('taskCompletion.create');
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['kid', 'mum', 'dad'] }, 'task');
  });

  it('send back pays nothing; a repeat still ticked from that check is unticked as by its own reset', async () => {
    await decideSubmission(H, mum, { submissionId: 's9', decision: 'send_back', reviewNote: 'Not clean' });
    expect(names()).not.toContain('pointAward.create');
    expect(written('subtask.updateMany')).toEqual([
      { where: { taskId: 't1', id: { in: ['a'] } }, data: { ...UNTICKED, autoResetAt: NOW } },
    ]);
    expect(subs[0]).toMatchObject({ status: 'sent_back', decidedById: 'mum', decidedAt: NOW, reviewNote: 'Not clean', waitingKey: 's9' });
    expect(written('notification.create')[0].data).toMatchObject({ title: 'Sent back: steps on Dishes', body: 'Not clean' });
    expect(names()).not.toContain('pendingCredit.deleteMany');
    expect(ready.announceTaskReady).not.toHaveBeenCalled();
  });

  it('only by an adult who looks after the child now', async () => {
    await expect(decideSubmission(H, boss, { submissionId: 's9', decision: 'approve' })).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(writes).toEqual([]);
  });
});

// --- Undo of a completion that sent steps for a check -----------------------------------

describe('undoCompletion of a completion that sent a child’s steps for a check', () => {
  const DONE_AT = new Date(NOW.getTime() - 60_000);
  const SNAP = JSON.stringify({
    status: 'in_progress', completedAt: null, dueDate: null, nextRunAt: null, cycleStartedAt: null, cycleEndsAt: null,
    opensAt: null, assigneeId: 'kid',
    steps: [
      { id: 'a', done: true, doneAt: QUEUED_AT.toISOString(), doneById: 'kid', checkAwardId: null, autoResetAt: null },
      { id: 'b', done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null },
    ],
    pending: [{ subtaskId: 'a', userId: 'kid', checkedAt: QUEUED_AT.toISOString(), cycleStartedAt: null }],
  });
  const diverted = entry('a', QUEUED_AT, { awardKind: 'step', completionId: 'done1' });
  function undoBySam() {
    tx.taskCompletion.findFirst.mockResolvedValueOnce({
      id: 'done1', taskId: 't1', userId: 'sam', outcome: 'completed', undoneAt: null, snapshot: SNAP,
      completedAt: DONE_AT, recordedAt: DONE_AT, submissionId: null,
      task: task({
        status: 'completed', updatedAt: DONE_AT,
        subtasks: [step('a', { done: true, doneAt: QUEUED_AT, doneById: 'kid' }), step('b', { position: 1, done: true, doneAt: DONE_AT, doneById: 'sam' })],
      }),
    });
    return undoCompletion(H, sam, 'done1');
  }

  it('still waiting: taken out of the check (left empty: withdrawn), the points queued again as before, and its awards voided', async () => {
    subs = [stepsCheck([diverted])];
    await undoBySam();
    expect(subs[0]).toMatchObject({ status: 'withdrawn', waitingKey: 's9' });
    expect(written('subtask.update')[0]).toEqual({ where: { id: 'a' }, data: { done: true, doneAt: QUEUED_AT, doneById: 'kid', checkAwardId: null, autoResetAt: null } });
    expect(written('pendingCredit.createMany')[0].data).toEqual([expect.objectContaining({ subtaskId: 'a', userId: 'kid' })]);
    // Approved entries from this completion carry its id, so they're voided with the rest.
    expect(written('pointAward.updateMany')[0].where).toMatchObject({ completionId: 'done1' });
    expect(pushSync).toHaveBeenCalledWith(H, { userIds: ['mum', 'dad'] }, 'task');
  });

  it('other entries in the same check stay waiting', async () => {
    subs = [stepsCheck([entry('b', EARLIER), diverted])];
    await undoBySam();
    expect(subs[0]).toMatchObject({ status: 'waiting' });
    expect(entriesOf('s9')).toEqual([entry('b', EARLIER)]);
  });

  it('sent back: no credit for that step survives and the child is not paid for it; the next completion pays it once, to whoever ticked it or else the completer; the child only by doing it again', async () => {
    subs = [stepsCheck([diverted], { status: 'sent_back' })];
    await undoBySam();
    // The send back stands: the step is unticked, its queued points left out.
    expect(written('subtask.update')[0]).toEqual({ where: { id: 'a' }, data: UNTICKED });
    expect(names()).not.toContain('pendingCredit.createMany');
    expect(subs[0]).toMatchObject({ status: 'sent_back' });

    // The next completion, with nothing queued: the completer finishes "a" and is paid once.
    writes.length = 0;
    stored = task({ subtasks: [step('a'), step('b', { position: 1 })] });
    pendingRows = [];
    await completeTask(H, sam, { taskId: 't1' });
    const paid = written('pointAward.createMany')[0].data as unknown as { userId: string; subtaskId: string }[];
    expect(paid.map((a) => [a.userId, a.subtaskId])).toEqual([['sam', 'a'], ['sam', 'b']]);

    // Or the child does it again: queued for them, and sent for a check when Sam completes it.
    writes.length = 0;
    stored = task({ subtasks: [step('a'), step('b', { position: 1 })] });
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(written('pendingCredit.create')[0].data).toMatchObject({ userId: 'kid', subtaskId: 'a' });
    writes.length = 0;
    pendingRows = [queued('a', 'kid', NOW)];
    await completeTask(H, sam, { taskId: 't1' });
    expect((written('pointAward.createMany')[0].data as unknown as { userId: string }[]).map((a) => a.userId)).toEqual(['sam']);
    expect(subs.filter((s) => s.status === 'waiting')).toHaveLength(1);
  });
});

// --- Settling steps checks ----------------------------------------------------------------

describe('settleOrphanedSubmissions for steps checks', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    subs = [stepsCheck([entry('a', TICK)])];
    stored = task({ subtasks: [step('a', { done: true, doneAt: TICK, doneById: 'kid' }), step('b', { position: 1 })] });
  });
  afterEach(() => log.mockRestore());

  it('a child who is gone: withdrawn, unpaid', async () => {
    delete people.kid;
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(subs[0]).toMatchObject({ status: 'withdrawn', waitingKey: 's9' });
    expect(names()).not.toContain('pointAward.create');
    expect(log).toHaveBeenCalledWith('[tasks] settled check s9 on task t1: withdrawn');
  });

  it('a child nobody looks after now: paid as they stand, told so, the task untouched', async () => {
    lookAfter = {};
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(written('pointAward.create')[0].data).toMatchObject({ userId: 'kid', subtaskId: 'a', kind: 'step_repeat', earnedAt: TICK, awardedAt: NOW });
    expect(subs[0]).toMatchObject({ status: 'auto_approved', autoReason: 'unsupervised', decidedById: null, decidedAt: NOW, waitingKey: 's9' });
    expect(written('notification.create')[0].data).toMatchObject({ userId: 'kid', title: 'Counted as done: steps on Dishes' });
    expect(names()).not.toContain('taskCompletion.create');
    // No roll afterwards: no task was completed (the one call is settle's own first look).
    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
  });

  it('checks turned off: paid unless the task asks for a photo', async () => {
    people.kid = { ...PEOPLE.kid, reviewTasks: null };
    stored = { ...stored, photoProof: true };
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(0);
    stored = { ...stored, photoProof: null };
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(subs[0]).toMatchObject({ status: 'auto_approved', autoReason: 'unsupervised' });
  });

  it('never because "Ask for a photo" was turned off after it was made: the check keeps what the task asked', async () => {
    // Made while the task asked for a photo; checks are off; Mum still looks after the kid.
    subs = [stepsCheck([entry('a', TICK)], { photoProof: true })];
    people.kid = { ...PEOPLE.kid, reviewTasks: null };
    stored = { ...stored, photoProof: null };
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(0);
    expect(writes).toEqual([]);
    expect(subs[0]).toMatchObject({ status: 'waiting' });
    // Losing every supervisor still counts it as done.
    lookAfter = {};
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
    expect(subs[0]).toMatchObject({ status: 'auto_approved', autoReason: 'unsupervised' });
  });

  it('a check made while no photo was asked is paid when checks are turned off, even if a photo is asked now', async () => {
    subs = [stepsCheck([entry('a', TICK)], { photoProof: false })];
    people.kid = { ...PEOPLE.kid, reviewTasks: null };
    stored = { ...stored, photoProof: true };
    expect(await settleOrphanedSubmissions(H, NOW)).toBe(1);
  });
});

describe('a check keeps whether its task asked for a photo', () => {
  const retick = () => task({ subtasks: [step('a', { autoResetAt: RESET_AT }), step('b', { position: 1, autoResetAt: RESET_AT })] });
  beforeEach(() => {
    pendingRow = queued('a');
  });

  it('a new steps check records it; an entry added while a photo is asked marks it for good', async () => {
    stored = retick();
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid);
    expect(subs).toEqual([expect.objectContaining({ kind: 'steps', photoProof: false })]);
    // The task now asks for a photo; the next re-tick adds to the same check.
    stored = { ...retick(), photoProof: true, subtasks: [step('a', { done: true, doneAt: NOW, doneById: 'kid' }), step('b', { position: 1, autoResetAt: RESET_AT })] };
    pendingRow = queued('b');
    await updateSubtask(H, { subtaskId: 'b', done: true }, kid);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ photoProof: true });
    expect(entriesOf(subs[0].id)).toHaveLength(2);
  });

  it('a whole task sent for a check records it', async () => {
    stored = task({ photoProof: true });
    await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true, note: 'No camera' });
    expect(subs).toEqual([expect.objectContaining({ kind: 'task', photoProof: true })]);
  });
});

// --- The lead's decisions (7a to 7c) and the step chip -------------------------------------

describe('decisions on checks of the whole task', () => {
  const sent = (over: Record<string, unknown> = {}): Sub => ({
    id: 's1', householdId: H, taskId: 't1', userId: 'kid', kind: 'task', status: 'waiting', prevStatus: 'in_progress',
    submittedAt: QUEUED_AT, cycleEndsAt: null, entries: null, waitingKey: 'task:t1', ...over,
  });

  it('a check counted as done because nobody looks after the child tells the child (7b)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    subs = [sent()];
    lookAfter = {};
    await settleOrphanedSubmissions(H, NOW);
    expect(written('notification.create').map((n) => n.data)).toContainEqual(
      expect.objectContaining({ userId: 'kid', type: 'task_reviewed', title: 'Counted as done: Dishes' }),
    );
    expect(subs[0]).toMatchObject({ status: 'auto_approved', waitingKey: 's1' });
    log.mockRestore();
  });

  it('a send back gives the child their "your turn" notice back, with no extra push (7c)', async () => {
    subs = [sent()];
    stored = task({ status: 'awaiting_review' });
    tx.task.findFirst.mockResolvedValueOnce(task({ status: 'awaiting_review' }));
    await decideSubmission(H, mum, { submissionId: 's1', decision: 'send_back', reviewNote: 'Again' });
    expect(ready.announceTaskReady).toHaveBeenCalledWith(tx, H, expect.objectContaining({ id: 't1', status: 'in_progress' }), 'mum', 'America/Chicago');
    expect(ready.pushTaskReady).not.toHaveBeenCalled();
    expect(subs[0]).toMatchObject({ status: 'sent_back', waitingKey: 's1' });
  });

  it('a take back logs it without a note (7a) and gives the notice back, pushed as an undo is (7c)', async () => {
    subs = [sent({ note: 'All done' })];
    ready.announceTaskReady.mockResolvedValueOnce('dad');
    await withdrawSubmission(H, kid, 's1');
    const activity = written('logActivity').at(-1) as unknown;
    expect(activity).toEqual({ householdId: H, actorId: 'kid', verb: 'updated', subjectType: 'task', subjectId: 't1', message: 'took back “Dishes” from the check' });
    expect(ready.announceTaskReady).toHaveBeenCalledWith(tx, H, expect.objectContaining({ id: 't1' }), 'kid');
    expect(ready.pushTaskReady).toHaveBeenCalledWith(H, ['dad']);
    expect(subs[0]).toMatchObject({ status: 'withdrawn', waitingKey: 's1' });
  });
});

// --- One waiting check at a time, even when two arrive together ---------------------------

describe('waitingKey: one waiting check per task, one steps check per task and child', () => {
  /** The other request's check, already written, but not seen by this one's first read. */
  function raced(row: Sub) {
    subs = [row];
    submissions.findFirst.mockImplementationOnce(async () => null);
  }

  it('a re-tick that loses the race to start the steps check runs again and adds to it, asking the limit once', async () => {
    stored = task({ subtasks: [step('a', { autoResetAt: RESET_AT }), step('b', { position: 1 })] });
    pendingRow = queued('a');
    raced(stepsCheck([entry('b', EARLIER)]));
    const allow = vi.fn(() => true);
    await updateSubtask(H, { subtaskId: 'a', done: true }, kid, { allowCheck: allow });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(subs).toHaveLength(1);
    expect(entriesOf('s9')).toEqual([entry('b', EARLIER), entry('a', NOW)]);
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it('a completion that loses the race to start a child’s steps check runs again and adds to it', async () => {
    pendingRows = [queued('a')];
    raced(stepsCheck([entry('b', EARLIER)]));
    await completeTask(H, sam, { taskId: 't1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(subs).toHaveLength(1);
    expect(entriesOf('s9').map((e) => [e.subtaskId, e.awardKind])).toEqual([['b', 'step_repeat'], ['a', 'step']]);
  });

  it('a second check of the same task sent at the same moment is refused (409), not run again', async () => {
    raced({ id: 's1', householdId: H, taskId: 't1', userId: 'kid', kind: 'task', status: 'waiting', waitingKey: 'task:t1' });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'This is already waiting for an OK.',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(subs).toHaveLength(1);
  });

  it('that refusal carries the code check_already_waiting', async () => {
    raced({ id: 's1', householdId: H, taskId: 't1', userId: 'kid', kind: 'task', status: 'waiting', waitingKey: 'task:t1' });
    await expect(completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true })).rejects.toMatchObject({
      message: 'This is already waiting for an OK.',
      code: 'check_already_waiting',
    });
  });

  it('a check sent for a task, or started for steps, is written with its waiting key', async () => {
    await completeTask(H, kid, { taskId: 't1', checks: 1, forCheck: true });
    expect(subs).toEqual([expect.objectContaining({ kind: 'task', status: 'waiting', waitingKey: 'task:t1' })]);
  });
});

describe('the task DTO: a step whose tick waits for an OK', () => {
  it('is marked for its current tick only', async () => {
    stored = task({ subtasks: [step('a', { done: true, doneAt: TICK, doneById: 'kid' }), step('b', { position: 1, done: true, doneAt: TICK, doneById: 'kid' })] });
    subs = [stepsCheck([entry('a', TICK), entry('b', EARLIER)])];
    const dto = await taskDTO(H, stored as never);
    expect(dto.subtasks.map((s) => s.waitingForOk)).toEqual([true, false]);
  });
});

describe('the task DTO for the member reading it (review.checkForMe, review.submissionId)', () => {
  /** A waiting "task" check from the kid on [taskId]. */
  const sent = (id: string, taskId: string): Sub => ({
    id, householdId: H, taskId, userId: 'kid', kind: 'task', status: 'waiting',
    submittedAt: RESET_AT, cycleEndsAt: null, waitingKey: `task:${taskId}`,
  });
  const plain = () => task({ id: 't1' });
  const photo = () => task({ id: 't2', photoProof: true });
  const forMe = async (viewer?: string) =>
    (await taskDTOs(H, [plain(), photo()] as never[], viewer)).map((d) => d.review.checkForMe);

  it('checkForMe is needsCheck for the viewer, task by task', async () => {
    // Checks on and looked after: every task.
    expect(await forMe('kid')).toEqual([true, true]);
    // Looked after with checks off: only the task that asks for a photo.
    lookAfter.sam = ['mum'];
    expect(await forMe('sam')).toEqual([false, true]);
    // Nobody looks after them: never.
    lookAfter = { kid: ['mum', 'dad'] };
    expect(await forMe('sam')).toEqual([false, false]);
    // Adults, the head, and a DTO for nobody in particular: never.
    expect(await forMe('mum')).toEqual([false, false]);
    expect(await forMe('boss')).toEqual([false, false]);
    expect(await forMe()).toEqual([false, false]);
  });

  it('submissionId only for the child who sent it and the adults who look after them now', async () => {
    subs = [sent('s1', 't1')];
    const seen = async (viewer?: string) => (await taskDTO(H, plain() as never, viewer)).review;
    expect(await seen('kid')).toMatchObject({ waiting: true, submissionId: 's1' });
    expect(await seen('mum')).toMatchObject({ waiting: true, submissionId: 's1' });
    // The head (not one of them), another child, and nobody in particular see that it waits, not its id.
    expect(await seen('boss')).toMatchObject({ waiting: true, submissionId: null });
    expect(await seen('sam')).toMatchObject({ waiting: true, submissionId: null });
    expect(await seen()).toMatchObject({ waiting: true, submissionId: null });
    // Mum no longer looks after the kid.
    lookAfter = { kid: ['dad'] };
    expect(await seen('mum')).toMatchObject({ submissionId: null });
    expect(await seen('dad')).toMatchObject({ submissionId: 's1' });
    // Nothing waiting: no id for anyone.
    subs = [];
    expect(await seen('kid')).toEqual({
      waiting: false, submittedBy: null, submittedAt: null, decideBy: null, checkForMe: true, submissionId: null,
    });
  });

  it('a list reads the viewer once, however many tasks it holds', async () => {
    const many = ['t1', 't2', 't3', 't4', 't5'];
    subs = many.map((id, i) => sent(`s${i}`, id));
    const rows = many.map((id) => task({ id }));
    // The child: needsCheck twice (a task asking for a photo, and one not); their own checks need no supervision read.
    const kidView = await taskDTOs(H, rows as never[], 'kid');
    expect(kidView.map((d) => d.review.submissionId)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.supervision.findMany).toHaveBeenCalledTimes(2);
    // An adult: one user read (not checked) and one read of whom they look after.
    prisma.user.findFirst.mockClear();
    prisma.supervision.findMany.mockClear();
    const mumView = await taskDTOs(H, rows as never[], 'mum');
    expect(mumView.every((d) => d.review.submissionId !== null && !d.review.checkForMe)).toBe(true);
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.supervision.findMany).toHaveBeenCalledTimes(1);
  });
});
