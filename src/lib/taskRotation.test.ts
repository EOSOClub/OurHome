import { describe, expect, it } from 'vitest';
import {
  assigneeForRotation,
  formatRotation,
  nextInRotation,
  parseRotation,
} from '@/lib/taskRotation';

describe('parseRotation / formatRotation', () => {
  it('round-trips ids in order', () => {
    expect(parseRotation(formatRotation(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });
  it('drops duplicates and blanks', () => {
    expect(formatRotation(['a', ' ', 'b', 'a'])).toBe('a,b');
  });
  it('treats fewer than two people as no rotation', () => {
    expect(formatRotation(['a'])).toBeNull();
    expect(formatRotation([])).toBeNull();
    expect(formatRotation(null)).toBeNull();
    expect(parseRotation(null)).toEqual([]);
  });
});

describe('nextInRotation', () => {
  const r = ['a', 'b', 'c'];
  it('moves one along and wraps', () => {
    expect(nextInRotation(r, 'a')).toBe('b');
    expect(nextInRotation(r, 'c')).toBe('a');
  });
  it('moves several turns at once (missed cycles)', () => {
    expect(nextInRotation(r, 'a', 2)).toBe('c');
    expect(nextInRotation(r, 'b', 4)).toBe('c');
  });
  it('starts at the top for someone outside the list or nobody', () => {
    expect(nextInRotation(r, 'z')).toBe('a');
    expect(nextInRotation(r, null)).toBe('a');
    expect(nextInRotation(r, null, 2)).toBe('b');
  });
  it('is null without a rotation', () => {
    expect(nextInRotation([], 'a')).toBeNull();
  });
});

describe('assigneeForRotation', () => {
  const r = ['a', 'b'];
  it('keeps a requested assignee in the rotation', () => {
    expect(assigneeForRotation(r, 'b', 'a')).toBe('b');
  });
  it('keeps the current assignee when none is requested', () => {
    expect(assigneeForRotation(r, undefined, 'b')).toBe('b');
  });
  it('falls back to the first person otherwise', () => {
    expect(assigneeForRotation(r, 'z', 'b')).toBe('a');
    expect(assigneeForRotation(r, null, 'b')).toBe('a');
    expect(assigneeForRotation(r, undefined, 'z')).toBe('a');
  });
  it('passes the request through without a rotation', () => {
    expect(assigneeForRotation([], 'z', 'a')).toBe('z');
    expect(assigneeForRotation([], null, 'a')).toBeNull();
  });
});
