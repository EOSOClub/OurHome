import { describe, expect, it } from 'vitest';
import { attentionReason, type AttentionRequest } from '@/lib/requestAttention';

const tomorrow = new Date('2026-10-10T05:00:00Z');
const base: AttentionRequest = { category: 'maintenance', status: 'pending', assigneeId: 'me', dueAt: null };

describe('attentionReason', () => {
  it('media waits on approvers only, until added', () => {
    const media = { ...base, category: 'media', status: null, assigneeId: null };
    expect(attentionReason(media, 'me', true, tomorrow)).toBe('approve');
    expect(attentionReason({ ...media, status: 'accepted' }, 'me', true, tomorrow)).toBe('approve');
    expect(attentionReason(media, 'me', false, tomorrow)).toBeNull();
    expect(attentionReason({ ...media, status: 'completed' }, 'me', true, tomorrow)).toBeNull();
  });

  it('maintenance asks the assignee to accept', () => {
    expect(attentionReason(base, 'me', false, tomorrow)).toBe('accept');
    expect(attentionReason(base, 'someone', true, tomorrow)).toBeNull();
  });

  it('accepted maintenance needs them once due today or overdue', () => {
    const accepted = { ...base, status: 'accepted' };
    expect(attentionReason({ ...accepted, dueAt: new Date('2026-10-09T17:00:00Z') }, 'me', false, tomorrow)).toBe('due');
    expect(attentionReason({ ...accepted, dueAt: new Date('2026-10-11T17:00:00Z') }, 'me', false, tomorrow)).toBeNull();
    expect(attentionReason(accepted, 'me', false, tomorrow)).toBeNull();
    expect(attentionReason({ ...base, status: 'completed' }, 'me', false, tomorrow)).toBeNull();
  });
});
