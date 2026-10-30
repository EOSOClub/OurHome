import { beforeEach, describe, expect, it, vi } from 'vitest';

// The 15-minute sweep settles task checks nobody can decide any more and
// deletes check photos kept long enough, after the cycles roll, for every
// household with Tasks on.

const prisma = { household: { findMany: vi.fn(async (): Promise<unknown[]> => []) } };
vi.mock('@/server/db/prisma', () => ({ prisma }));
const order: string[] = [];
const step = (name: string) => vi.fn(async () => {
  order.push(name);
  return 0;
});
const tasks = { rollTaskCycles: step('roll'), resetDueSubtasks: step('reset') };
vi.mock('@/server/services/taskService', () => tasks);
const checks = { settleOrphanedSubmissions: step('settle'), deleteExpiredPhotos: step('photos') };
vi.mock('@/server/services/taskSubmissionService', () => checks);
vi.mock('@/server/services/reminderService', () => ({ generateReminders: step('reminders') }));
vi.mock('@/server/services/paperlessSync', () => ({ runPaperlessSync: vi.fn(async () => undefined) }));
vi.mock('@/server/services/appReleaseService', () => ({ announceAppRelease: vi.fn(async () => undefined) }));
const admin = { isFeatureEnabled: vi.fn(async () => true) };
vi.mock('@/server/services/serverAdminService', () => admin);
vi.mock('@/server/services/phoneStatusService', () => ({ refreshPhoneAlerts: step('alerts') }));
vi.mock('@/server/services/pushService', () => ({ forgetStaleDevices: vi.fn(async () => undefined) }));

const { runReminderSweep } = await import('./reminderSweep');

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
});

describe('runReminderSweep and task checks', () => {
  it('settles checks and deletes old photos after the cycles roll', async () => {
    prisma.household.findMany.mockResolvedValueOnce([{ id: 'h1', disabledAt: null }]);
    await runReminderSweep();
    expect(checks.settleOrphanedSubmissions).toHaveBeenCalledWith('h1');
    expect(checks.deleteExpiredPhotos).toHaveBeenCalledWith('h1');
    expect(order).toEqual(['roll', 'reset', 'settle', 'photos', 'reminders', 'alerts']);
  });

  it('leaves them alone while Tasks is off for the household', async () => {
    prisma.household.findMany.mockResolvedValueOnce([{ id: 'h1', disabledAt: null }]);
    admin.isFeatureEnabled.mockResolvedValueOnce(false);
    await runReminderSweep();
    expect(checks.settleOrphanedSubmissions).not.toHaveBeenCalled();
    expect(checks.deleteExpiredPhotos).not.toHaveBeenCalled();
  });

  it('a failed settle never stops the rest of the sweep', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    prisma.household.findMany.mockResolvedValueOnce([{ id: 'h1', disabledAt: null }]);
    checks.settleOrphanedSubmissions.mockRejectedValueOnce(new Error('boom'));
    await runReminderSweep();
    expect(checks.deleteExpiredPhotos).toHaveBeenCalledWith('h1');
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
