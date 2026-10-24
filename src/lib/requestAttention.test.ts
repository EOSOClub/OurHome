import { describe, expect, it } from 'vitest';
import { attentionReason, type AttentionRequest, type RequestDeciding } from '@/lib/requestAttention';

const tomorrow = new Date('2026-10-10T05:00:00Z');
const base: AttentionRequest = { category: 'maintenance', status: 'pending', requesterId: 'kid', assigneeId: 'me', dueAt: null };
const deciding = (d: Partial<RequestDeciding> = {}): RequestDeciding => ({
  handles: new Set(),
  bySupervisors: new Set(),
  supervised: new Set(),
  supervising: new Set(),
  ...d,
});
const handlesMedia = deciding({ handles: new Set(['media']) });
const handlesNothing = deciding();

describe('attentionReason', () => {
  it('media waits on those who handle it only, until added', () => {
    const media = { ...base, category: 'media', status: null, assigneeId: null };
    expect(attentionReason(media, 'me', handlesMedia, tomorrow)).toBe('approve');
    expect(attentionReason({ ...media, status: 'accepted' }, 'me', handlesMedia, tomorrow)).toBe('approve');
    expect(attentionReason(media, 'me', handlesNothing, tomorrow)).toBeNull();
    expect(attentionReason({ ...media, status: 'completed' }, 'me', handlesMedia, tomorrow)).toBeNull();
  });

  it('a declined request waits on nobody', () => {
    const media = { ...base, category: 'media', status: 'declined', assigneeId: null };
    expect(attentionReason(media, 'me', handlesMedia, tomorrow)).toBeNull();
  });

  it('maintenance asks the assignee to accept', () => {
    expect(attentionReason(base, 'me', handlesNothing, tomorrow)).toBe('accept');
    expect(attentionReason(base, 'someone', handlesMedia, tomorrow)).toBeNull();
  });

  it('accepted maintenance needs them once due today or overdue', () => {
    const accepted = { ...base, status: 'accepted' };
    expect(attentionReason({ ...accepted, dueAt: new Date('2026-10-09T17:00:00Z') }, 'me', handlesNothing, tomorrow)).toBe('due');
    expect(attentionReason({ ...accepted, dueAt: new Date('2026-10-11T17:00:00Z') }, 'me', handlesNothing, tomorrow)).toBeNull();
    expect(attentionReason(accepted, 'me', handlesNothing, tomorrow)).toBeNull();
    expect(attentionReason({ ...base, status: 'completed' }, 'me', handlesNothing, tomorrow)).toBeNull();
  });

  it('ignores kinds this server does not know', () => {
    expect(attentionReason({ ...base, category: 'rides' }, 'me', handlesMedia, tomorrow)).toBeNull();
  });

  describe('where supervisors decide', () => {
    const permission = { ...base, category: 'permission', assigneeId: null };
    const kidHasSupervisors = { bySupervisors: new Set(['permission']), supervised: new Set(['kid']) };

    it('a supervised requester’s request waits on their supervisors only', () => {
      const parent = deciding({ ...kidHasSupervisors, supervising: new Set(['kid']) });
      const head = deciding({ ...kidHasSupervisors, handles: new Set(['permission']) });
      expect(attentionReason(permission, 'me', parent, tomorrow)).toBe('approve');
      expect(attentionReason(permission, 'me', head, tomorrow)).toBeNull();
      expect(attentionReason({ ...permission, status: 'completed' }, 'me', parent, tomorrow)).toBeNull();
    });

    it('anyone without supervisors goes to the usual handlers', () => {
      const adultAsks = { ...permission, requesterId: 'adult' };
      const head = deciding({ ...kidHasSupervisors, handles: new Set(['permission']) });
      const parent = deciding({ ...kidHasSupervisors, supervising: new Set(['kid']) });
      expect(attentionReason(adultAsks, 'me', head, tomorrow)).toBe('approve');
      expect(attentionReason(adultAsks, 'me', parent, tomorrow)).toBeNull();
    });

    it('a kind without the rule ignores supervisors', () => {
      const purchase = { ...permission, category: 'purchase' };
      const parent = deciding({ ...kidHasSupervisors, supervising: new Set(['kid']) });
      expect(attentionReason(purchase, 'me', parent, tomorrow)).toBeNull();
      expect(attentionReason(purchase, 'me', deciding({ handles: new Set(['purchase']) }), tomorrow)).toBe('approve');
    });
  });
});
