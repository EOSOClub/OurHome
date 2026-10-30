import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/tasks/complete as the app calls it: the larger body cap for a
// photo, and the per-user limit on sending checks, which never touches an
// ordinary completion.

let user = { id: 'adult1', householdId: 'household1', role: 'adult' };
vi.mock('@/server/auth/session', () => ({ getServerSession: vi.fn(async () => ({ user })) }));
vi.mock('@/server/services/serverAdminService', () => ({
  HOUSEHOLD_DISABLED_MESSAGE: 'off',
  isHouseholdDisabled: vi.fn(async () => false),
  isFeatureEnabled: vi.fn(async () => true),
  isServerAdmin: vi.fn(async () => false),
}));
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn() }));
const tasks = {
  completeTask: vi.fn(async () => ({ task: { id: 't1' }, completionId: 'c1' as string | null, submissionId: undefined as string | undefined })),
  taskDTO: vi.fn(async () => ({ id: 't1' })),
};
vi.mock('@/server/services/taskService', () => tasks);

const { POST } = await import('@/app/api/tasks/complete/route');
const { COMPLETE_BODY_MAX_BYTES } = await import('@/lib/validation/task');
const { ConflictError } = await import('@/server/services/errors');

const ID = 'cmabcdefghijklmnopqrstuvw';
function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest('http://localhost/api/tasks/complete', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `ip-${user.id}`, ...headers },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/tasks/complete', () => {
  it('lets an adult complete 11 tasks in a minute: ordinary completions are never limited by checks', async () => {
    user = { id: 'adult1', householdId: 'household1', role: 'adult' };
    for (let i = 0; i < 11; i++) {
      const res = await post({ taskId: ID, checks: 1 });
      expect(res.status).toBe(200);
    }
    expect(tasks.completeTask).toHaveBeenCalledTimes(11);
  });

  it('limits sending checks to 10 a minute for each person', async () => {
    user = { id: 'kid1', householdId: 'household1', role: 'child' };
    tasks.completeTask.mockResolvedValue({ task: { id: 't1' }, completionId: null, submissionId: 's1' });
    for (let i = 0; i < 10; i++) {
      expect((await post({ taskId: ID, checks: 1, forCheck: true })).status).toBe(200);
    }
    const limited = await post({ taskId: ID, checks: 1, forCheck: true });
    expect(limited.status).toBe(429);
    expect(tasks.completeTask).toHaveBeenCalledTimes(10);
    // Someone else's checks are counted on their own.
    user = { id: 'kid2', householdId: 'household1', role: 'child' };
    expect((await post({ taskId: ID, checks: 1, forCheck: true })).status).toBe(200);
  });

  it('answers a check with the submission instead of a completion', async () => {
    user = { id: 'kid3', householdId: 'household1', role: 'child' };
    tasks.completeTask.mockResolvedValueOnce({ task: { id: 't1' }, completionId: null, submissionId: 's1' });
    const res = await post({ taskId: ID, checks: 1, forCheck: true });
    expect(await res.json()).toEqual({ ok: true, data: { id: 't1', completionId: null, submissionId: 's1' } });
  });

  it('refuses a body over the cap with 413, before any work', async () => {
    user = { id: 'kid4', householdId: 'household1', role: 'child' };
    const res = await post({ taskId: ID, forCheck: true, photo: 'A'.repeat(COMPLETE_BODY_MAX_BYTES) });
    expect(res.status).toBe(413);
    expect(tasks.completeTask).not.toHaveBeenCalled();
  });

  it('a check refusal carries its machine code next to the message; other refusals are as before', async () => {
    user = { id: 'kid6', householdId: 'household1', role: 'child' };
    tasks.completeTask.mockRejectedValueOnce(new ConflictError('This task now needs a check.', undefined, 'check_needed'));
    const coded = await post({ taskId: ID, checks: 1 });
    expect(coded.status).toBe(409);
    expect(await coded.json()).toEqual({
      ok: false,
      error: { message: 'This task now needs a check.', details: { code: 'check_needed' } },
    });
    tasks.completeTask.mockRejectedValueOnce(new ConflictError('Someone else just completed this task.'));
    const plain = await post({ taskId: ID, checks: 1 });
    expect(await plain.json()).toEqual({ ok: false, error: { message: 'Someone else just completed this task.' } });
    // A code and a field together keep both.
    tasks.completeTask.mockRejectedValueOnce(new ConflictError('Taken.', 'title', 'some_code'));
    const both = await post({ taskId: ID, checks: 1 });
    expect((await both.json()).error.details).toEqual({ code: 'some_code', fieldErrors: { title: ['Taken.'] } });
  });

  it('refuses a photo sent without a check (422)', async () => {
    user = { id: 'kid5', householdId: 'household1', role: 'child' };
    const res = await post({ taskId: ID, checks: 1, photo: 'AQID' });
    expect(res.status).toBe(422);
    expect(tasks.completeTask).not.toHaveBeenCalled();
  });
});
