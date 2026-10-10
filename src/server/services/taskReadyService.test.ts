import { describe, expect, it } from 'vitest';
import { taskReadyBody } from '@/server/services/taskReadyService';

describe('taskReadyBody', () => {
  const base = { id: 't', title: 'Bins', assigneeId: 'u' };

  it('says whose turn it is for a rotation, with the local due day', () => {
    expect(
      taskReadyBody(
        { ...base, rotationUserIds: 'u,v', dueDate: new Date('2026-10-09T17:00:00Z') },
        'America/Chicago',
      ),
    ).toBe('It’s your turn — due Fri, Oct 9.');
  });

  it('reads plainly without a rotation or due date', () => {
    expect(taskReadyBody({ ...base, dueDate: null })).toBe('Ready for you.');
  });
});
