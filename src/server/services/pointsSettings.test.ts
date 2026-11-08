import { describe, expect, it, vi } from 'vitest';

const prisma = {
  household: {
    update: vi.fn(async () => ({ timezone: 'Asia/Tokyo', weekStartsOn: 1, minutesPerPoint: 5 })),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const runs = { markRemindersStale: vi.fn() };
vi.mock('@/server/services/reminderRuns', () => runs);

const { updatePointsSettings } = await import('./pointsService');

describe('updatePointsSettings', () => {
  it('marks the household reminders stale, since their times depend on the zone', async () => {
    await updatePointsSettings('hh', { timezone: 'Asia/Tokyo' });
    expect(prisma.household.update).toHaveBeenCalled();
    // A settings save logs no activity, so nothing else would mark them.
    expect(runs.markRemindersStale).toHaveBeenCalledWith('hh');
  });
});
