import { describe, expect, it } from 'vitest';
import {
  buildBillReminders,
  buildInventoryReminders,
  buildOverdueReminders,
  buildReminders,
  selectNewReminders,
  type BillLike,
  type InventoryLike,
  type ReminderCandidate,
  type TaskLike,
} from '@/server/services/reminderService';
import { buildReminderEmail } from '@/server/email/notificationEmail';

const NOW = new Date('2026-06-24T12:00:00.000Z');
const iso = (s: string) => new Date(s);

function task(partial: Partial<TaskLike>): TaskLike {
  return { id: 't1', title: 'Task', status: 'pending', dueDate: null, ...partial };
}

function item(partial: Partial<InventoryLike>): InventoryLike {
  return {
    id: 'i1',
    name: 'Item',
    unit: null,
    quantity: 0,
    isLow: false,
    predictedDepletionAt: null,
    ...partial,
  };
}

function bill(partial: Partial<BillLike>): BillLike {
  return { id: 'b1', name: 'Bill', status: 'unpaid', dueDate: null, ...partial };
}

describe('buildOverdueReminders', () => {
  it('flags active tasks past their due date', () => {
    const out = buildOverdueReminders(
      [task({ id: 'a', dueDate: iso('2026-06-23T00:00:00.000Z') })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dedupeKey: 'overdue:task:a',
      type: 'overdue',
      subjectType: 'task',
      subjectId: 'a',
    });
  });

  it('ignores future, undated, completed, and archived tasks', () => {
    const out = buildOverdueReminders(
      [
        task({ id: 'future', dueDate: iso('2026-06-25T00:00:00.000Z') }),
        task({ id: 'undated', dueDate: null }),
        task({ id: 'done', status: 'completed', dueDate: iso('2026-06-01T00:00:00.000Z') }),
        task({ id: 'archived', status: 'archived', dueDate: iso('2026-06-01T00:00:00.000Z') }),
      ],
      NOW,
    );
    expect(out).toHaveLength(0);
  });
});

describe('buildInventoryReminders', () => {
  it('flags low-stock items as low_inventory', () => {
    const out = buildInventoryReminders([item({ id: 'x', isLow: true })], NOW);
    expect(out).toEqual([
      expect.objectContaining({
        dedupeKey: 'low_inventory:inventory_item:x',
        type: 'low_inventory',
        subjectId: 'x',
      }),
    ]);
  });

  it('flags items predicted to deplete within the window as reminder', () => {
    const out = buildInventoryReminders(
      [item({ id: 'y', predictedDepletionAt: iso('2026-06-25T00:00:00.000Z') })],
      NOW,
      3,
    );
    expect(out[0]).toMatchObject({
      dedupeKey: 'reminder:inventory_item:y',
      type: 'reminder',
    });
  });

  it('does not flag depletion beyond the window', () => {
    const out = buildInventoryReminders(
      [item({ id: 'z', predictedDepletionAt: iso('2026-07-30T00:00:00.000Z') })],
      NOW,
      3,
    );
    expect(out).toHaveLength(0);
  });

  it('emits only the low notification when an item is both low and depleting', () => {
    const out = buildInventoryReminders(
      [
        item({
          id: 'w',
          isLow: true,
          predictedDepletionAt: iso('2026-06-25T00:00:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('low_inventory');
  });
});

describe('buildBillReminders', () => {
  it('flags unpaid bills due within the window as bill_due', () => {
    const out = buildBillReminders(
      [bill({ id: 'soon', dueDate: iso('2026-06-25T00:00:00.000Z') })],
      NOW,
      3,
    );
    expect(out).toEqual([
      expect.objectContaining({
        dedupeKey: 'bill_due:bill:soon',
        type: 'bill_due',
        subjectType: 'bill',
        subjectId: 'soon',
      }),
    ]);
  });

  it('flags overdue unpaid bills with the same stable key', () => {
    const out = buildBillReminders(
      [bill({ id: 'late', dueDate: iso('2026-06-20T00:00:00.000Z') })],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].dedupeKey).toBe('bill_due:bill:late');
    expect(out[0].body).toMatch(/past its due date/);
  });

  it('ignores paid, undated, and far-future bills', () => {
    const out = buildBillReminders(
      [
        bill({ id: 'paid', status: 'paid', dueDate: iso('2026-06-20T00:00:00.000Z') }),
        bill({ id: 'undated', dueDate: null }),
        bill({ id: 'future', dueDate: iso('2026-07-30T00:00:00.000Z') }),
      ],
      NOW,
      3,
    );
    expect(out).toHaveLength(0);
  });
});

function candidate(partial: Partial<ReminderCandidate>): ReminderCandidate {
  return {
    dedupeKey: 'overdue:task:c1',
    type: 'overdue',
    title: 'Candidate',
    body: null,
    subjectType: 'task',
    subjectId: 'c1',
    ...partial,
  };
}

describe('selectNewReminders', () => {
  it('keeps only candidates whose dedupeKey has no existing notification', () => {
    const fresh = candidate({ dedupeKey: 'bill_due:bill:new' });
    const stale = candidate({ dedupeKey: 'overdue:task:seen' });
    const out = selectNewReminders([fresh, stale], ['overdue:task:seen']);
    expect(out).toEqual([fresh]);
  });

  it('returns everything when nothing exists yet, nothing on a pure refresh', () => {
    const all = [candidate({ dedupeKey: 'a' }), candidate({ dedupeKey: 'b' })];
    expect(selectNewReminders(all, [])).toEqual(all);
    expect(selectNewReminders(all, ['a', 'b'])).toEqual([]);
  });
});

describe('buildReminderEmail', () => {
  it('builds a typed subject and includes the body and a section link', () => {
    const { subject, text } = buildReminderEmail(
      candidate({
        type: 'bill_due',
        title: 'Electric bill',
        body: 'This bill is due soon.',
        subjectType: 'bill',
      }),
      'https://home.example.com/',
    );
    expect(subject).toBe('Bill due: Electric bill');
    expect(text).toContain('This bill is due soon.');
    expect(text).toContain('https://home.example.com/bills');
    expect(text).not.toContain('.com//'); // trailing slash on base is trimmed
  });

  it('omits the link when no base URL is configured', () => {
    const { text } = buildReminderEmail(
      candidate({ type: 'overdue', title: 'Mow lawn' }),
      null,
    );
    expect(text).not.toContain('http');
  });

  it('falls back to the inbox path for unknown subject types', () => {
    const { subject, text } = buildReminderEmail(
      { type: 'custom', title: 'Hi', body: null, subjectType: 'other' },
      'https://home.example.com',
    );
    expect(subject).toBe('Notification: Hi');
    expect(text).toContain('https://home.example.com/notifications');
  });
});

describe('buildReminders idempotency', () => {
  it('produces identical, stable dedupeKeys across runs (upsert-safe)', () => {
    const tasks = [task({ id: 'a', dueDate: iso('2026-06-23T00:00:00.000Z') })];
    const items = [item({ id: 'x', isLow: true })];
    const bills = [bill({ id: 'b', dueDate: iso('2026-06-25T00:00:00.000Z') })];
    const first = buildReminders(tasks, items, bills, NOW).map((c) => c.dedupeKey);
    const second = buildReminders(tasks, items, bills, NOW).map((c) => c.dedupeKey);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length); // no duplicates
  });
});
