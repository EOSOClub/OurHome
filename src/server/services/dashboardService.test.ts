import { describe, expect, it, vi } from 'vitest';

// Requests in the database, oldest first; findMany honors `take` like Prisma.
type Req = { id: string; category: string; status: string | null; requesterId: string; assigneeId: string | null; dueAt: Date | null; createdAt: Date };
let requests: Req[] = [];

const prisma = {
  task: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
  inventoryItem: { count: vi.fn(async () => 0) },
  shoppingItem: { count: vi.fn(async () => 0) },
  bill: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
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
