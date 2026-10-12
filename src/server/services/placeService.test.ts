import { beforeEach, describe, expect, it, vi } from 'vitest';

type TaskRow = { id: string; roomId: string | null; floorId: string | null; extraRoomIds: string[]; extraFloorIds: string[] };
let tasks: TaskRow[] = [];

// Only what deletePlace touches; task writes are collected to check.
const prisma = {
  room: { findFirst: vi.fn(), delete: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(async () => []) },
  floor: { findFirst: vi.fn(), delete: vi.fn(), findMany: vi.fn(async () => []) },
  task: {
    findMany: vi.fn(async () => tasks),
    update: vi.fn((args: { where: { id: string }; data: Omit<TaskRow, 'id'> }) => args),
  },
  inventoryItem: { updateMany: vi.fn() },
  nfcTag: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));

const { deletePlace } = await import('./placeService');

const written = () => Object.fromEntries(prisma.task.update.mock.calls.map(([a]) => [a.where.id, a.data]));

describe('deletePlace with tasks in several places', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tasks = [
      // Kitchen first, plus the Bathroom.
      { id: 't1', roomId: 'kit', floorId: null, extraRoomIds: ['bath'], extraFloorIds: [] },
      // Only the Kitchen: moves up to its floor, as before.
      { id: 't2', roomId: 'kit', floorId: null, extraRoomIds: [], extraFloorIds: [] },
      // The Kitchen as an extra place.
      { id: 't3', roomId: null, floorId: 'up', extraRoomIds: ['kit'], extraFloorIds: [] },
    ];
  });

  it('turns a deleted room into its floor and keeps the other places', async () => {
    prisma.room.findFirst.mockResolvedValueOnce({ id: 'kit', name: 'Kitchen', floorId: 'main' });
    await deletePlace('h1', 'u1', { kind: 'room', id: 'kit' });
    expect(written()).toEqual({
      t1: { roomId: null, floorId: 'main', extraRoomIds: ['bath'], extraFloorIds: [] },
      t2: { roomId: null, floorId: 'main', extraRoomIds: [], extraFloorIds: [] },
      t3: { roomId: null, floorId: 'up', extraRoomIds: [], extraFloorIds: ['main'] },
    });
  });

  it('drops a deleted room on no floor, leaving the whole house only when nothing is left', async () => {
    prisma.room.findFirst.mockResolvedValueOnce({ id: 'kit', name: 'Kitchen', floorId: null });
    await deletePlace('h1', 'u1', { kind: 'room', id: 'kit' });
    expect(written()).toEqual({
      t1: { roomId: 'bath', floorId: null, extraRoomIds: [], extraFloorIds: [] },
      t2: { roomId: null, floorId: null, extraRoomIds: [], extraFloorIds: [] },
      t3: { roomId: null, floorId: 'up', extraRoomIds: [], extraFloorIds: [] },
    });
  });

  it('drops a deleted whole floor and keeps rooms', async () => {
    prisma.floor.findFirst.mockResolvedValueOnce({ id: 'up', name: 'Upstairs' });
    await deletePlace('h1', 'u1', { kind: 'floor', id: 'up' });
    expect(written().t3).toEqual({ roomId: 'kit', floorId: null, extraRoomIds: [], extraFloorIds: [] });
  });
});
