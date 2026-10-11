import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { announceTaskReady, taskReadyBody } from '@/server/services/taskReadyService';

describe('announceTaskReady', () => {
  it('gives each notice a per-task dedupeKey (the unique index rejects a second keyless row)', async () => {
    const create = vi.fn();
    const db = { notification: { create, deleteMany: vi.fn() } } as unknown as Prisma.TransactionClient;
    const task = { id: 't1', title: 'Bins', assigneeId: 'u', dueDate: null };
    await announceTaskReady(db, 'h', task, null);
    await announceTaskReady(db, 'h', { ...task, id: 't2' }, null);
    expect(create.mock.calls.map((c) => c[0].data.dedupeKey)).toEqual(['task_ready:task:t1', 'task_ready:task:t2']);
  });
});

describe('taskReadyBody', () => {
  const base = { id: 't', title: 'Bins', assigneeId: 'u' };

  it('says whose turn it is for a rotation, with the local due day', () => {
    expect(
      taskReadyBody(
        { ...base, rotationUserIds: 'u,v', dueDate: new Date('2026-10-09T17:00:00Z') },
        'America/Chicago',
      ),
    ).toBe('It’s your turn - due Fri, Oct 9.');
  });

  it('reads plainly without a rotation or due date', () => {
    expect(taskReadyBody({ ...base, dueDate: null })).toBe('Ready for you.');
  });
});
