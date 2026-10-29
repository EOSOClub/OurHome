import { describe, expect, it } from 'vitest';
import { planRestore, RESTORE_ORDER } from '@/server/services/householdRestore';
import { HOUSEHOLD_MODELS } from '@/server/services/householdDataService';

// Old ids as Prisma makes them ("c" + 24).
const id = (n: number) => `c${String(n).padStart(24, '0')}`;
const H = id(1);
const HEAD = id(2);
const KID = id(3);
const TASK = id(4);
const STEP = id(5);
const DONE = id(6);
const RULE = id(7);
const LIST = id(8);
const ITEM = id(9);
const FLOOR = id(12);
const ROOM = id(13);
const STOCK = id(14);
const TAG = id(15);

function sampleExport() {
  return {
    format: 'ourhome-household-export',
    version: 1,
    exportedAt: '2026-10-10T12:00:00.000Z',
    household: { id: H, name: 'The Smiths', timezone: 'America/Chicago', createdAt: '2026-01-01T00:00:00.000Z' },
    members: [
      { id: HEAD, name: 'Pat', username: 'pat', email: 'pat@example.com', role: 'head', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: KID, name: 'Sam', username: 'sam', email: 'sam@household.local', role: 'child', createdAt: '2026-01-02T00:00:00.000Z' },
    ],
    categories: [],
    tasks: [
      {
        id: TASK,
        householdId: H,
        title: 'Bins',
        assigneeId: KID,
        rotationUserIds: `${KID},${HEAD}`,
        recurrenceId: RULE,
        category: null,
        recurrence: { id: RULE, kind: 'weekly', interval: 1 },
        subtasks: [{ id: STEP, taskId: TASK, title: 'Take out', doneById: KID }],
        completions: [
          { id: DONE, taskId: TASK, userId: KID, snapshot: JSON.stringify({ assigneeId: HEAD, steps: [{ id: STEP }] }) },
        ],
      },
    ],
    points: { awards: [], pending: [] },
    activity: [],
    calendar: [],
    bills: [],
    billPayments: [],
    shoppingLists: [{ id: LIST, householdId: H, name: 'Groceries', items: [{ id: ITEM, listId: LIST, name: 'Milk' }] }],
    requests: [],
    bugReports: [],
    places: { floors: [{ id: FLOOR, householdId: H, name: 'Ground' }], rooms: [{ id: ROOM, householdId: H, floorId: FLOOR, name: 'Garage' }] },
    inventory: { items: [{ id: STOCK, householdId: H, name: 'Ice', roomId: ROOM, floorId: null }], purchases: [] },
    notifications: [
      { id: id(10), householdId: H, dedupeKey: `overdue:task:${TASK}`, audienceUserIds: [KID, HEAD], subjectId: TASK },
    ],
    nfcTags: [{ id: TAG, householdId: H, tagId: 'garage_door', represents: 'location', roomId: ROOM }],
    homeAssistant: [{ id: id(11), name: 'HA' }],
    paperless: { url: 'http://paperless:8000' },
  };
}

// Fresh ids, distinguishable from the old ones.
function newIds() {
  let n = 100;
  return () => `c${String(n++).padStart(24, '9')}`;
}

// Fields the schema has, per model (enough for the sample; the real run asks Prisma).
const FIELDS: Record<string, string[]> = {
  Household: ['id', 'name', 'timezone', 'createdAt', 'disabledAt'],
  User: ['id', 'name', 'username', 'email', 'role', 'createdAt', 'householdId', 'mustChangePassword', 'emailVerified', 'isServerAdmin'],
  Task: ['id', 'householdId', 'title', 'assigneeId', 'rotationUserIds', 'recurrenceId'],
  Subtask: ['id', 'taskId', 'title', 'doneById'],
  TaskCompletion: ['id', 'taskId', 'userId', 'snapshot'],
  RecurrenceRule: ['id', 'kind', 'interval'],
  ShoppingList: ['id', 'householdId', 'name'],
  ShoppingItem: ['id', 'listId', 'name'],
  Notification: ['id', 'householdId', 'dedupeKey', 'audienceUserIds', 'subjectId'],
  Floor: ['id', 'householdId', 'name'],
  Room: ['id', 'householdId', 'floorId', 'name'],
  InventoryItem: ['id', 'householdId', 'name', 'roomId', 'floorId'],
  NfcTag: ['id', 'householdId', 'tagId', 'represents', 'roomId'],
};
const fields = (model: string) => new Set(FIELDS[model] ?? ['id']);

describe('planRestore', () => {
  const plan = planRestore(sampleExport(), { newId: newIds(), fields });
  const old = new Set([H, HEAD, KID, TASK, STEP, DONE, RULE, LIST, ITEM, FLOOR, ROOM, STOCK, TAG]);
  const containsOld = (v: unknown) => [...old].some((o) => JSON.stringify(v).includes(o));

  it('gives every record a new id and leaves no old id anywhere', () => {
    for (const model of RESTORE_ORDER) expect(containsOld(plan.rows[model])).toBe(false);
  });

  it('rewires references, including ids inside text', () => {
    const task = plan.rows.Task[0];
    const [head, kid] = plan.rows.User;
    expect(task.householdId).toBe(plan.householdId);
    expect(task.assigneeId).toBe(kid.id);
    expect(task.rotationUserIds).toBe(`${kid.id},${head.id}`);
    expect(task.recurrenceId).toBe(plan.rows.RecurrenceRule[0].id);
    expect(plan.rows.Subtask[0].taskId).toBe(task.id);
    const snap = JSON.parse(plan.rows.TaskCompletion[0].snapshot as string);
    expect(snap.assigneeId).toBe(head.id);
    expect(snap.steps[0].id).toBe(plan.rows.Subtask[0].id);
    expect(plan.rows.ShoppingItem[0].listId).toBe(plan.rows.ShoppingList[0].id);
    const note = plan.rows.Notification[0];
    expect(note.dedupeKey).toBe(`overdue:task:${task.id}`);
    expect(note.audienceUserIds).toEqual([kid.id, head.id]);
  });

  it('keeps where stock is kept and which room a location tag opens', () => {
    const room = plan.rows.Room[0];
    expect(room.floorId).toBe(plan.rows.Floor[0].id);
    expect(plan.rows.InventoryItem[0].roomId).toBe(room.id);
    expect(plan.rows.NfcTag[0].roomId).toBe(room.id);
  });

  it('drops relation objects and fields the schema lacks', () => {
    expect(plan.rows.Task[0]).not.toHaveProperty('subtasks');
    expect(plan.rows.Task[0]).not.toHaveProperty('recurrence');
    expect(plan.rows.Task[0]).not.toHaveProperty('category');
    expect(plan.rows.ShoppingList[0]).not.toHaveProperty('items');
  });

  it('restores members as needing a new password, never as server admin', () => {
    for (const u of plan.rows.User) {
      expect(u.mustChangePassword).toBe(true);
      expect(u).not.toHaveProperty('isServerAdmin');
    }
    expect(plan.headId).toBe(plan.rows.User[0].id);
    expect(plan.usernames).toEqual(['pat', 'sam']);
  });

  it('notes what has to be reconnected or reset', () => {
    expect(plan.notes.join(' ')).toMatch(/Home Assistant/);
    expect(plan.notes.join(' ')).toMatch(/Paperless/);
    expect(plan.notes.join(' ')).toMatch(/1 other member needs a temporary password/);
  });

  it('renames the old "member" role to "adult", in members and the role grid', () => {
    const old = sampleExport();
    const legacy = {
      ...old,
      household: { ...old.household, roleAccess: JSON.stringify({ member: { tasks: { create: true } }, teen: {} }) },
      members: [...old.members, { id: id(16), name: 'Jo', username: 'jo', role: 'member' }],
    };
    const withGrid = (model: string) => (model === 'Household' ? new Set([...FIELDS.Household, 'roleAccess']) : fields(model));
    const restored = planRestore(legacy, { newId: newIds(), fields: withGrid });
    expect(restored.rows.User.map((u) => u.role)).toEqual(['head', 'child', 'adult']);
    expect(JSON.parse(restored.rows.Household[0].roleAccess as string)).toEqual({
      adult: { tasks: { create: true } },
      teen: {},
    });
  });

  it('leaves a grid without the old role key untouched', () => {
    const old = sampleExport();
    const grid = JSON.stringify({ adult: { bills: { create: false } } });
    const withGrid = (model: string) => (model === 'Household' ? new Set([...FIELDS.Household, 'roleAccess']) : fields(model));
    const restored = planRestore({ ...old, household: { ...old.household, roleAccess: grid } }, { newId: newIds(), fields: withGrid });
    expect(restored.rows.Household[0].roleAccess).toBe(grid);
  });

  it('keeps who supervises whom', () => {
    const link = { id: id(17), householdId: H, supervisorId: HEAD, supervisedId: KID, createdById: HEAD };
    const withLinks = (model: string) =>
      model === 'Supervision' ? new Set(['id', 'householdId', 'supervisorId', 'supervisedId', 'createdById']) : fields(model);
    const restored = planRestore({ ...sampleExport(), supervision: [link] }, { newId: newIds(), fields: withLinks });
    const [head, kid] = restored.rows.User;
    expect(restored.rows.Supervision).toEqual([
      { id: expect.not.stringMatching(link.id), householdId: restored.householdId, supervisorId: head.id, supervisedId: kid.id, createdById: head.id },
    ]);
  });

  it('restores an export from before supervision with none', () => {
    expect(plan.rows.Supervision).toEqual([]);
  });

  it('keeps the points spent on screen time, so the balance stays right', () => {
    const spent = { id: id(18), householdId: H, userId: KID, day: '2026-10-10', minutes: 15, pointsCenti: 300, byId: KID };
    const withSpent = (model: string) =>
      model === 'ExtraTime'
        ? new Set(['id', 'householdId', 'userId', 'day', 'minutes', 'pointsCenti', 'byId'])
        : fields(model);
    const sample = sampleExport() as ReturnType<typeof sampleExport> & { points?: Record<string, unknown> };
    const restored = planRestore(
      { ...sample, points: { ...(sample.points ?? {}), spent: [spent] } },
      { newId: newIds(), fields: withSpent },
    );
    const kid = restored.rows.User[1];
    expect(restored.rows.ExtraTime).toEqual([
      { ...spent, id: expect.not.stringMatching(spent.id), householdId: restored.householdId, userId: kid.id, byId: kid.id },
    ]);
    // Exports from before it have none.
    expect(plan.rows.ExtraTime).toEqual([]);
  });

  it('keeps a repeating event’s skipped dates and its dates changed on their own', () => {
    const SERIES = id(20);
    const OVERRIDE = id(21);
    const EV_RULE = id(22);
    const skipped = ['2026-11-09T15:00:00.000Z', '2026-11-16T15:00:00.000Z'];
    const calendar = [
      {
        id: SERIES,
        householdId: H,
        title: 'Piano',
        startAt: '2026-11-02T15:00:00.000Z',
        recurrenceId: EV_RULE,
        excludedStarts: skipped,
        reminderMinutes: 15,
        createdById: KID,
        recurrence: { id: EV_RULE, kind: 'yearly', interval: 1 },
        attendees: [{ id: id(23), eventId: SERIES, userId: KID }],
      },
      {
        id: OVERRIDE,
        householdId: H,
        title: 'Recital',
        startAt: '2026-11-09T18:00:00.000Z',
        seriesId: SERIES,
        originalStart: skipped[0],
        createdById: KID,
        attendees: [],
      },
      // An event from an export made before these fields existed.
      { id: id(24), householdId: H, title: 'Dentist', startAt: '2026-11-03T15:00:00.000Z', attendees: [] },
    ];
    // The real schema's fields: proves Event has the new ones.
    const restored = planRestore({ ...sampleExport(), calendar }, { newId: newIds() });
    const [series, override, old] = restored.rows.Event;
    expect(series.excludedStarts).toEqual(skipped);
    expect(series.reminderMinutes).toBe(15);
    expect(series.recurrenceId).toBe(restored.rows.RecurrenceRule.find((r) => r.kind === 'yearly')!.id);
    expect(override.seriesId).toBe(series.id);
    expect(override.originalStart).toBe(skipped[0]);
    expect(restored.rows.EventAttendee[0].eventId).toBe(series.id);
    expect(old).not.toHaveProperty('excludedStarts');
    expect(old).not.toHaveProperty('seriesId');
  });

  it('can restore under a new name', () => {
    expect(planRestore(sampleExport(), { name: 'Smiths (restored)', newId: newIds(), fields }).rows.Household[0].name).toBe(
      'Smiths (restored)',
    );
  });

  it('refuses files that are not exports, or from a newer version', () => {
    expect(() => planRestore({ hello: 1 }, { fields })).toThrow(/isn’t an Our Home household export/);
    expect(() => planRestore({ ...sampleExport(), version: 99 }, { fields })).toThrow(/newer version/);
    expect(() => planRestore({ ...sampleExport(), members: [] }, { fields })).toThrow(/no Head of House/);
  });

  it('writes only household models', () => {
    for (const model of RESTORE_ORDER) expect(HOUSEHOLD_MODELS).toContain(model);
  });
});
