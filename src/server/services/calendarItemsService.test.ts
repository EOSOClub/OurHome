import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const features = vi.fn();
vi.mock('@/server/db/prisma', () => ({ prisma: { task: { findMany } } }));
vi.mock('@/server/services/serverAdminService', () => ({ getHouseholdFeatures: features }));
vi.mock('@/server/services/pointsService', () => ({
  getPointsSettings: vi.fn(async () => ({ timezone: 'America/Chicago' })),
}));

const { listChoreItems } = await import('./calendarItemsService');

const START = new Date('2026-11-01T05:00:00.000Z');
const END = new Date('2026-12-01T05:59:59.999Z');
const NOW = new Date('2026-11-10T18:00:00.000Z'); // Nov 10, noon Chicago (CST)

beforeEach(() => {
  findMany.mockReset();
  features.mockReset();
  features.mockResolvedValue(['tasks', 'calendar']);
});

describe('listChoreItems', () => {
  it('lists open chores due in the range, oldest first', async () => {
    findMany.mockResolvedValue([
      // Picked without a time: stored at 12:00 Chicago, due all day.
      { id: 't1', title: 'Bins', dueDate: new Date('2026-11-09T18:00:00.000Z'), assigneeId: 'u1', assignee: { name: 'Sam' } },
      { id: 't2', title: 'Vet', dueDate: new Date('2026-11-12T15:30:00.000Z'), assigneeId: null, assignee: null },
    ]);
    const out = await listChoreItems('hh', START, END, NOW);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          householdId: 'hh',
          status: { in: ['pending', 'in_progress', 'awaiting_review'] },
          dueDate: { gte: START, lte: END },
        },
        orderBy: { dueDate: 'asc' },
      }),
    );
    expect(out).toEqual([
      {
        id: 't1',
        title: 'Bins',
        due: '2026-11-09T18:00:00.000Z',
        allDay: true,
        assigneeId: 'u1',
        assigneeName: 'Sam',
        overdue: true,
      },
      {
        id: 't2',
        title: 'Vet',
        due: '2026-11-12T15:30:00.000Z',
        allDay: false,
        assigneeId: null,
        assigneeName: null,
        overdue: false,
      },
    ]);
  });

  it('keeps a chore waiting for an OK on the calendar, never as overdue', async () => {
    findMany.mockResolvedValue([
      { id: 't1', title: 'Bins', dueDate: new Date('2026-11-09T18:00:00.000Z'), status: 'awaiting_review', assigneeId: 'u1', assignee: { name: 'Sam' } },
      { id: 't2', title: 'Dishes', dueDate: new Date('2026-11-09T18:00:00.000Z'), status: 'pending', assigneeId: 'u1', assignee: { name: 'Sam' } },
    ]);
    const out = await listChoreItems('hh', START, END, NOW);
    expect(out.map((c) => [c.id, c.overdue])).toEqual([
      ['t1', false],
      ['t2', true],
    ]);
  });

  it('shows none when Tasks is turned off for the household', async () => {
    features.mockResolvedValue(['calendar']);
    expect(await listChoreItems('hh', START, END, NOW)).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
