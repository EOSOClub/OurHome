import { describe, expect, it } from 'vitest';
import { createEventSchema, deleteEventSchema, updateEventSchema } from '@/lib/validation/calendar';

const ID = 'cmabcdefghijklmnopqrstuvw';

describe('event scope', () => {
  it('defaults to the whole event, so older callers keep working', () => {
    expect(updateEventSchema.parse({ id: ID, title: 'x' }).scope).toBe('all');
    expect(deleteEventSchema.parse({ id: ID }).scope).toBe('all');
  });

  it('needs the opened date for "this" and "following"', () => {
    for (const scope of ['this', 'following'] as const) {
      expect(updateEventSchema.safeParse({ id: ID, scope }).success).toBe(false);
      expect(deleteEventSchema.safeParse({ id: ID, scope }).success).toBe(false);
      const ok = deleteEventSchema.parse({ id: ID, scope, occurrenceStart: '2026-11-02T15:00:00.000Z' });
      expect(ok.occurrenceStart).toEqual(new Date('2026-11-02T15:00:00.000Z'));
    }
  });

  it('refuses an unknown scope', () => {
    expect(deleteEventSchema.safeParse({ id: ID, scope: 'some' }).success).toBe(false);
  });

  it('accepts a yearly repeat', () => {
    const parsed = updateEventSchema.parse({ id: ID, recurrence: { kind: 'yearly', interval: 1 } });
    expect(parsed.recurrence?.kind).toBe('yearly');
  });
});

describe('event kinds', () => {
  const base = { title: 'x', startAt: '2026-11-10T00:00:00.000Z' };
  const yearly = { kind: 'yearly', interval: 1 };

  it('makes a plain event when no kind is given', () => {
    expect(createEventSchema.parse(base).kind).toBe('event');
  });

  it('needs a birthday or anniversary to be all day and yearly', () => {
    for (const kind of ['birthday', 'anniversary']) {
      expect(createEventSchema.safeParse({ ...base, kind, allDay: true, recurrence: yearly }).success).toBe(true);
      expect(createEventSchema.safeParse({ ...base, kind, allDay: false, recurrence: yearly }).success).toBe(false);
      expect(createEventSchema.safeParse({ ...base, kind, allDay: true }).success).toBe(false);
    }
  });

  it('refuses a reminder with an end', () => {
    expect(createEventSchema.safeParse({ ...base, kind: 'reminder' }).success).toBe(true);
    expect(
      createEventSchema.safeParse({ ...base, kind: 'reminder', endAt: '2026-11-10T01:00:00.000Z' }).success,
    ).toBe(false);
  });

  it('refuses the kinds only a bill makes, and a year still to come', () => {
    expect(createEventSchema.safeParse({ ...base, kind: 'bill' }).success).toBe(false);
    const next = new Date().getUTCFullYear() + 1;
    expect(
      createEventSchema.safeParse({ ...base, kind: 'birthday', allDay: true, recurrence: yearly, sinceYear: next }).success,
    ).toBe(false);
  });
});
