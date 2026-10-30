import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// POST /api/subtasks/update as the app calls it to tick a step: the per-user
// limit on checks is asked only when a tick puts step points in a check
// (Task Photo Proof), and a refusal is answered 429.

let user = { id: 'adult1', householdId: 'household1', role: 'adult' };
vi.mock('@/server/auth/session', () => ({ getServerSession: vi.fn(async () => ({ user })) }));
vi.mock('@/server/services/serverAdminService', () => ({
  HOUSEHOLD_DISABLED_MESSAGE: 'off',
  isHouseholdDisabled: vi.fn(async () => false),
  isFeatureEnabled: vi.fn(async () => true),
  isServerAdmin: vi.fn(async () => false),
}));
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn(), recordOwner: { subtask: vi.fn() } }));
const { TooManyRequestsError } = await import('@/server/services/errors');
/** Stands in for the service: a tick that makes a check entry asks the limit first, as setStepDone does. */
let makesEntry = false;
const tasks = {
  updateSubtask: vi.fn(async (_hh: string, _input: unknown, _actor: unknown, opts: { allowCheck?: () => boolean }) => {
    if (makesEntry && opts.allowCheck && !opts.allowCheck()) {
      throw new TooManyRequestsError('That’s a lot of checks at once. Wait a minute, then try again.');
    }
    return { id: 't1' };
  }),
  taskDTO: vi.fn(async () => ({ id: 't1' })),
};
vi.mock('@/server/services/taskService', () => tasks);

const { POST } = await import('@/app/api/subtasks/update/route');

const ID = 'cmabcdefghijklmnopqrstuvw';
function tick() {
  return POST(
    new NextRequest('http://localhost/api/subtasks/update', {
      method: 'POST',
      body: JSON.stringify({ subtaskId: ID, done: true }),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `ip-${user.id}` },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/subtasks/update: ticking a step', () => {
  it('never limits ordinary ticks', async () => {
    user = { id: 'adult1', householdId: 'household1', role: 'adult' };
    makesEntry = false;
    for (let i = 0; i < 11; i++) expect((await tick()).status).toBe(200);
  });

  it('limits ticks that put points in a check to 10 a minute for each person (429)', async () => {
    user = { id: 'kid1', householdId: 'household1', role: 'child' };
    makesEntry = true;
    for (let i = 0; i < 10; i++) expect((await tick()).status).toBe(200);
    const limited = await tick();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ ok: false, error: { message: 'That’s a lot of checks at once. Wait a minute, then try again.' } });
    // Someone else's are counted on their own.
    user = { id: 'kid2', householdId: 'household1', role: 'child' };
    expect((await tick()).status).toBe(200);
  });
});
