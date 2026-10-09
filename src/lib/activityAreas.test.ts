import { describe, expect, it } from 'vitest';
import { areaOf, isActivityArea, subjectFilter } from '@/lib/activityAreas';

describe('areaOf', () => {
  it('maps feature subjects to their page', () => {
    expect(areaOf('task')).toBe('tasks');
    expect(areaOf('shopping_list')).toBe('shopping');
    expect(areaOf('nfc_tag')).toBe('inventory');
    expect(areaOf('event')).toBe('calendar');
  });

  it('puts admin and unknown subjects under household', () => {
    expect(areaOf('permissions')).toBe('household');
    expect(areaOf('member')).toBe('household');
    expect(areaOf('something_new')).toBe('household');
  });
});

describe('subjectFilter', () => {
  it('household excludes every feature subject', () => {
    const f = subjectFilter('household');
    expect('notIn' in f && f.notIn).toEqual(expect.arrayContaining(['task', 'bill', 'request']));
  });

  it('feature areas match their own subjects only', () => {
    expect(subjectFilter('bills')).toEqual({ in: ['bill'] });
  });
});

it('isActivityArea rejects unknown strings', () => {
  expect(isActivityArea('tasks')).toBe(true);
  expect(isActivityArea('admin')).toBe(false);
});
