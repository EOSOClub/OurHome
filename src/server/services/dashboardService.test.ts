import { describe, expect, it, vi } from 'vitest';

// Requests in the database, oldest first; findMany honors `take` like Prisma.
type Req = { id: string; category: string; status: string | null; requesterId: string; assigneeId: string | null; dueAt: Date | null; createdAt: Date };
let requests: Req[] = [];

const prisma = {
  task: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
  inventoryItem: { count: vi.fn(async () => 0) },
  shoppingItem: { count: vi.fn(async () => 0) },
  bill: { count: vi.fn(async () => 0), findMany: vi.fn(async (): Promise<unknown[]> => []) },
  billPayment: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  taskCompletion: { count: vi.fn(async () => 0) },
  request: {
    findMany: vi.fn(async (args: { take?: number }) => requests.slice(0, args.take ?? requests.length)),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/calendarService', () => ({ listOccurrences: vi.fn(async () => []) }));
vi.mock('@/server/services/pointsService', () => ({
  getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })),
  pointsSummary: vi.fn(async () => ({ members: [] })),
}));
vi.mock('@/server/services/taskPlaces', () => ({ loadPlaceIndex: vi.fn(async () => ({})), resolveTaskPlaces: vi.fn(() => []) }));
vi.mock('@/server/services/serverAdminService', () => ({ getHouseholdFeatures: vi.fn(async () => ['requests']) }));
vi.mock('@/server/services/requestModuleService', () => ({
  getRequestHandling: vi.fn(async () => ({
    on: ['media', 'purchase'],
    handles: new Set(['media', 'purchase']),
    bySupervisors: new Set(),
    supervised: new Set(),
    supervising: new Set(),
  })),
}));
vi.mock('@/server/services/taskSubmissionService', () => ({ countTasksToCheck: vi.fn(async () => 0) }));

const { getDashboard } = await import('./dashboardService');

const access = { requests: { approve: true } } as never;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

describe('dashboard "Coming up" bills', () => {
  it('says what is already paid toward the current cycle', async () => {
    const { getHouseholdFeatures } = await import('@/server/services/serverAdminService');
    vi.mocked(getHouseholdFeatures).mockResolvedValueOnce(['bills'] as never);
    const due = day(40);
    const closed = new Date(0); // billService CLOSED_CYCLE: a payment of a cycle that ended
    prisma.bill.findMany.mockResolvedValueOnce([
      { id: 'once', name: 'Car repair', amount: 200, currency: 'USD', dueDate: due, recurrenceId: null },
      { id: 'rent', name: 'Rent', amount: 900, currency: 'USD', dueDate: due, recurrenceId: 'r1' },
      { id: 'none', name: 'Water', amount: 40, currency: 'USD', dueDate: due, recurrenceId: null },
    ]);
    prisma.billPayment.findMany.mockResolvedValueOnce([
      { billId: 'once', amount: 150, cycleDueDate: null },
      { billId: 'once', amount: 50, cycleDueDate: closed },
      { billId: 'rent', amount: 300, cycleDueDate: due },
      // Last month's rent: not toward this one.
      { billId: 'rent', amount: 900, cycleDueDate: day(9) },
    ]);
    requests = [];
    const data = await getDashboard({ id: 'head', householdId: 'h1' }, access);
    expect(data.upcomingBills.map((b) => [b.id, b.paidTotal])).toEqual([
      ['once', 150],
      ['rent', 300],
      ['none', 0],
    ]);
    // The row keeps its shape for older apps; the repeat id stays inside.
    expect(data.upcomingBills[0]).not.toHaveProperty('recurrenceId');
  });
});

describe('dashboard counts and events', () => {
  it('counts every overdue task, not only the 25 it lists', async () => {
    const { getHouseholdFeatures } = await import('@/server/services/serverAdminService');
    vi.mocked(getHouseholdFeatures).mockResolvedValueOnce(['tasks'] as never);
    // The count's own query asks for the dates alone.
    prisma.task.findMany.mockImplementation((async (args: { select: Record<string, unknown> }) =>
      'title' in args.select ? [] : Array.from({ length: 30 }, () => ({ dueDate: day(-400), dueAllDay: false }))) as never);
    requests = [];
    const data = await getDashboard({ id: 'head', householdId: 'h1' }, access);
    prisma.task.findMany.mockImplementation(async () => []);
    expect(data.counts.overdue).toBe(30);
  });

  it('leaves a bill’s calendar entry out of the events (the bill is listed itself)', async () => {
    const { getHouseholdFeatures } = await import('@/server/services/serverAdminService');
    const { listOccurrences } = await import('@/server/services/calendarService');
    vi.mocked(getHouseholdFeatures).mockResolvedValueOnce(['calendar'] as never);
    vi.mocked(listOccurrences).mockResolvedValueOnce([
      { eventId: 'e1', title: 'Dentist', billId: null },
      { eventId: 'e2', title: 'Rent', billId: 'b1' },
    ] as never);
    requests = [];
    const data = await getDashboard({ id: 'head', householdId: 'h1' }, access);
    expect(data.upcomingEvents.map((e) => e.eventId)).toEqual(['e1']);
  });
});

describe('dashboard "Needs you" requests', () => {
  it('a new request still shows behind a long list of ones that wait on nobody', async () => {
    // 25 media requests already taken on (they wait on nobody), then a new purchase request.
    requests = Array.from({ length: 25 }, (_, i) => ({
      id: `m${i}`,
      category: 'media',
      status: 'accepted',
      requesterId: 'sam',
      assigneeId: null,
      dueAt: null,
      createdAt: day(i),
    }));
    requests.push({ id: 'p1', category: 'purchase', status: 'pending', requesterId: 'sam', assigneeId: null, dueAt: null, createdAt: day(30) });
    const data = await getDashboard({ id: 'head', householdId: 'h1' }, access);
    expect(data.me.requests.map((r) => r.id)).toEqual(['p1']);
  });

  it('keeps the oldest first and shows at most 20', async () => {
    requests = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      category: 'purchase',
      status: 'pending',
      requesterId: 'sam',
      assigneeId: null,
      dueAt: null,
      createdAt: day(i),
    }));
    const data = await getDashboard({ id: 'head', householdId: 'h1' }, access);
    expect(data.me.requests.map((r) => r.id)).toEqual(requests.slice(0, 20).map((r) => r.id));
  });
});
