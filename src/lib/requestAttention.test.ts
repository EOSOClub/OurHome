import { describe, expect, it } from 'vitest';
import { attentionReason, type AttentionRequest } from '@/lib/requestAttention';

const tomorrow = new Date('2026-10-10T05:00:00Z');
const base: AttentionRequest = { category: 'maintenance', status: 'pending', assigneeId: 'me', dueAt: null };
const handlesMedia = new Set(['media']);
const handlesNothing = new Set<string>();

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
});
