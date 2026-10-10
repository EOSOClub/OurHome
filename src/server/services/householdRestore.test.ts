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
    inventory: { items: [], purchases: [] },
    notifications: [
      { id: id(10), householdId: H, dedupeKey: `overdue:task:${TASK}`, audienceUserIds: [KID, HEAD], subjectId: TASK },
    ],
    nfcTags: [],
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
};
const fields = (model: string) => new Set(FIELDS[model] ?? ['id']);

describe('planRestore', () => {
  const plan = planRestore(sampleExport(), { newId: newIds(), fields });
  const old = new Set([H, HEAD, KID, TASK, STEP, DONE, RULE, LIST, ITEM]);
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
