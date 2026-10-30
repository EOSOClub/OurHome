import { describe, expect, it } from 'vitest';
import {
  buildBillReminders,
  buildEventReminders,
  buildInventoryReminders,
  eventReminderWindow,
  type EventReminderLike,
  buildOverdueReminders,
  buildReminders,
  buildTrialReminders,
  reminderRecipients,
  selectNewReminders,
  withManagers,
  type BillLike,
  type InventoryLike,
  type ReminderCandidate,
  type TaskLike,
} from '@/server/services/reminderService';
import { buildReminderEmail } from '@/server/email/notificationEmail';

const NOW = new Date('2026-06-24T12:00:00.000Z');
const iso = (s: string) => new Date(s);

describe('buildEventReminders', () => {
  // Chicago is UTC-5 in June.
  const tz = 'America/Chicago';
  const event = (over: Partial<EventReminderLike> = {}): EventReminderLike => ({
    eventId: 'ev1',
    title: 'Dentist',
    start: iso('2026-06-24T20:00:00.000Z'), // 3:00 PM Chicago
    end: iso('2026-06-24T21:00:00.000Z'),
    allDay: false,
    reminderMinutes: 15,
    attendeeIds: ['kid'],
    createdById: 'mom',
    ...over,
  });

  it('shows from the reminder time, not before', () => {
    expect(buildEventReminders([event()], iso('2026-06-24T19:44:00.000Z'), tz)).toEqual([]);
    const [c] = buildEventReminders([event()], iso('2026-06-24T19:45:00.000Z'), tz);
    expect(c).toMatchObject({
      dedupeKey: 'event_reminder:event:ev1:2026-06-24T20:00:00.000Z',
      type: 'event_reminder',
      title: 'Dentist',
      subjectType: 'event',
      subjectId: 'ev1',
    });
    expect(c.body).toMatch(/^Today at 3:00\s?PM\.$/);
  });

  it('goes to the attendees and the creator only', () => {
    const [c] = buildEventReminders([event({ attendeeIds: ['kid', 'mom'] })], iso('2026-06-24T19:50:00.000Z'), tz);
    expect(c.audienceUserIds).toEqual(['kid', 'mom']);
  });

  it('is gone once the event is over (an hour on without an end)', () => {
    expect(buildEventReminders([event()], iso('2026-06-24T20:59:00.000Z'), tz)).toHaveLength(1);
    expect(buildEventReminders([event()], iso('2026-06-24T21:00:00.000Z'), tz)).toEqual([]);
    const noEnd = event({ end: null });
    expect(buildEventReminders([noEnd], iso('2026-06-24T20:59:00.000Z'), tz)).toHaveLength(1);
    expect(buildEventReminders([noEnd], iso('2026-06-24T21:00:00.000Z'), tz)).toEqual([]);
  });

  it('skips events without a reminder', () => {
    expect(buildEventReminders([event({ reminderMinutes: null })], iso('2026-06-24T20:00:00.000Z'), tz)).toEqual([]);
  });

  it('counts an all-day event back from 9:00 on its day, household time', () => {
    // All day Thursday Jun 25 (midnight Chicago), reminder 1 day before.
    const allDay = event({
      allDay: true,
      start: iso('2026-06-25T05:00:00.000Z'),
      end: null,
      reminderMinutes: 1440,
    });
    expect(eventReminderWindow(allDay, tz)).toEqual({
      fireAt: iso('2026-06-24T14:00:00.000Z'), // Wed 9:00 Chicago
      until: iso('2026-06-26T05:00:00.000Z'), // end of Thursday
    });
    expect(buildEventReminders([allDay], iso('2026-06-24T13:59:00.000Z'), tz)).toEqual([]);
    const [c] = buildEventReminders([allDay], iso('2026-06-24T14:00:00.000Z'), tz);
    expect(c.body).toBe('Tomorrow, all day.');
    // The next morning the same row reads "Today".
    expect(buildEventReminders([allDay], iso('2026-06-25T13:00:00.000Z'), tz)[0].body).toBe('Today, all day.');
  });

  it('gives each date of a repeating event its own reminder, with the place', () => {
    const a = event({ location: 'Main St' });
    const b = event({ start: iso('2026-06-24T20:30:00.000Z'), end: null });
    const out = buildEventReminders([a, b], iso('2026-06-24T20:20:00.000Z'), tz);
    expect(out.map((c) => c.dedupeKey)).toEqual([
      'event_reminder:event:ev1:2026-06-24T20:00:00.000Z',
      'event_reminder:event:ev1:2026-06-24T20:30:00.000Z',
    ]);
    expect(out[0].body).toMatch(/\(Main St\)\.$/);
  });

  it('emails it as "Coming up" with a calendar link', () => {
    const [c] = buildEventReminders([event()], iso('2026-06-24T19:50:00.000Z'), tz);
    const mail = buildReminderEmail(c, 'https://home.example');
    expect(mail.subject).toBe('Coming up: Dentist');
    expect(mail.text).toContain('https://home.example/calendar');
  });
});

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

  it('never reminds about a task waiting for an adult’s OK', () => {
    const out = buildOverdueReminders(
      [task({ id: 'sent', status: 'awaiting_review', dueDate: iso('2026-06-01T00:00:00.000Z') })],
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
    audienceUserIds: [],
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

describe('reminder audience', () => {
  it('ties a task to its assignee and creator, once each', () => {
    const [c] = buildOverdueReminders(
      [task({ dueDate: iso('2026-06-20T12:00:00.000Z'), assigneeId: 'kid', createdById: 'kid' })],
      NOW,
    );
    expect(c.audienceUserIds).toEqual(['kid']);
  });

  it('ties a bill to its assignee and creator, and stock to its creator', () => {
    const [b] = buildBillReminders(
      [bill({ dueDate: iso('2026-06-25T12:00:00.000Z'), assignedUserId: 'a', createdById: 'c' })],
      NOW,
    );
    expect(b.audienceUserIds).toEqual(['a', 'c']);
    const [i] = buildInventoryReminders([item({ isLow: true, createdById: 'c' })], NOW);
    expect(i.audienceUserIds).toEqual(['c']);
  });

  it("adds each subject's page managers, without duplicates", () => {
    const out = withManagers(
      buildReminders(
        [task({ dueDate: iso('2026-06-20T12:00:00.000Z'), assigneeId: 'kid', createdById: 'head' })],
        [item({ isLow: true })],
        [bill({ dueDate: iso('2026-06-25T12:00:00.000Z'), assignedUserId: 'teen' })],
        NOW,
      ),
      { tasks: ['head'], bills: ['head', 'mgr'], inventory: ['head', 'mgr', 'mem'] },
    );
    const bySubject = Object.fromEntries(out.map((c) => [c.subjectType, c.audienceUserIds]));
    expect(bySubject.task).toEqual(['kid', 'head']);
    expect(bySubject.bill).toEqual(['teen', 'head', 'mgr']);
    expect(bySubject.inventory_item).toEqual(['head', 'mgr', 'mem']);
  });

  it('emails only the audience', () => {
    const c = candidate({ audienceUserIds: ['kid1', 'h'] });
    const members = [{ id: 'h' }, { id: 'm' }, { id: 'kid1' }, { id: 'kid2' }];
    expect(reminderRecipients(c, members).map((m) => m.id)).toEqual(['h', 'kid1']);
  });
});

describe('buildTrialReminders', () => {
  // Chicago is UTC-5 in June. The trial ends Saturday Jun 27 (noon local).
  const tz = 'America/Chicago';
  const sub = { id: 's1', name: 'Netflix', trialEndsAt: iso('2026-06-27T17:00:00.000Z'), assignedUserId: 'u2', createdById: 'u1' };

  it('says nothing more than 3 days ahead', () => {
    // Jun 23, 11 PM local: 4 days left.
    expect(buildTrialReminders([sub], iso('2026-06-24T04:00:00.000Z'), tz)).toEqual([]);
  });

  it('counts down from 3 days before, for the responsible person and maker', () => {
    // Jun 24 from midnight local.
    const [c] = buildTrialReminders([sub], iso('2026-06-24T05:00:00.000Z'), tz);
    expect(c).toMatchObject({
      dedupeKey: 'subscription_trial:bill:s1',
      type: 'subscription_trial',
      title: 'Netflix',
      subjectType: 'bill',
      subjectId: 's1',
      audienceUserIds: ['u2', 'u1'],
    });
    expect(c.body).toContain('ends in 3 days');
    expect(buildTrialReminders([sub], iso('2026-06-26T15:00:00.000Z'), tz)[0].body).toContain('ends tomorrow');
  });

  it('says today on the day, and is gone once the day is over', () => {
    expect(buildTrialReminders([sub], iso('2026-06-28T04:59:00.000Z'), tz)[0].body).toContain('ends today');
    expect(buildTrialReminders([sub], iso('2026-06-28T05:00:00.000Z'), tz)).toEqual([]);
  });

  it('adds the Bills managers like a bill reminder', () => {
    const [c] = withManagers(buildTrialReminders([sub], iso('2026-06-26T15:00:00.000Z'), tz), { bills: ['u9'] });
    expect(c.audienceUserIds).toEqual(['u2', 'u1', 'u9']);
  });
});
