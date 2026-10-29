import { describe, expect, it } from 'vitest';
import { deleteEventSchema, updateEventSchema } from '@/lib/validation/calendar';

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
