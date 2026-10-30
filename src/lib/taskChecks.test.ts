import { describe, expect, it } from 'vitest';
import type { TaskSubmissionEntryDTO } from '@/lib/types';
import { ApiError } from '@/lib/api';
import { checkCode, checkTime, entryLines, plusPoints } from '@/lib/taskChecks';

const TZ = 'America/Chicago';
// Wed 2026-10-28 18:00 in Chicago.
const NOW = new Date('2026-10-28T23:00:00.000Z');

function entry(patch: Partial<TaskSubmissionEntryDTO>): TaskSubmissionEntryDTO {
  return {
    subtaskId: 'a',
    title: 'Wipe the counter',
    points: 1,
    checkedAt: '2026-10-27T21:12:00.000Z',
    awardKind: 'step_repeat',
    completionId: null,
    completedBy: null,
    ...patch,
  };
}

describe('checkCode', () => {
  it('reads the refusal code, not the message', () => {
    expect(checkCode(new ApiError('This task now needs a check.', 409, { code: 'check_needed' }))).toBe('check_needed');
    expect(checkCode(new ApiError('Anything', 409, { code: 'check_not_needed' }))).toBe('check_not_needed');
    expect(checkCode(new ApiError('Update the Our Home app to send this for a check.', 409, { code: 'update_app' }))).toBe(
      'update_app',
    );
    expect(checkCode(new ApiError('Someone already decided this.', 409, { code: 'check_decided' }))).toBe('check_decided');
  });

  it('is null without a check code', () => {
    expect(checkCode(new ApiError('This task now needs a check.', 409))).toBeNull();
    expect(checkCode(new ApiError('Off', 403, { code: 'feature_disabled' }))).toBeNull();
    expect(checkCode(new ApiError('Bad', 422, { fieldErrors: { photo: ['x'] } }))).toBeNull();
    expect(checkCode(new Error('network'))).toBeNull();
  });
});

describe('labels', () => {
  it('says pt for exactly one point', () => {
    expect(plusPoints(1)).toBe('+1 pt');
    expect(plusPoints(5)).toBe('+5 pts');
    expect(plusPoints(2.5)).toBe('+2.5 pts');
  });

  it('shows only the time today, the weekday before', () => {
    expect(checkTime('2026-10-28T21:12:00.000Z', TZ, NOW)).toMatch(/^4:12\sPM$/);
    expect(checkTime('2026-10-27T21:12:00.000Z', TZ, NOW)).toMatch(/^Tue 4:12\sPM$/);
  });
});

describe('entryLines', () => {
  it('writes a re-tick per line and groups steps before a completion', () => {
    const lines = entryLines(
      [
        entry({}),
        entry({
          subtaskId: 'b',
          title: 'Dry',
          points: 2,
          awardKind: 'step',
          completionId: 'c7',
          completedBy: { id: 'sam', name: 'Sam' },
          checkedAt: '2026-10-28T23:00:00.000Z',
        }),
        entry({
          subtaskId: 'c',
          title: 'Sweep',
          points: 1,
          awardKind: 'step',
          completionId: 'c7',
          completedBy: { id: 'sam', name: 'Sam' },
          checkedAt: '2026-10-28T23:30:00.000Z',
        }),
      ],
      TZ,
      new Date('2026-10-30T12:00:00.000Z'),
    ).map((l) => l.text.replace(/\s/g, ' '));
    expect(lines).toEqual([
      'Ticked “Wipe the counter” again · Tue 4:12 PM (+1 pt)',
      'Ticked 2 steps before Sam finished it · Wed 6:30 PM (+3 pts)',
    ]);
  });
});
