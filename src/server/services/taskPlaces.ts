import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { taskPlaceIds } from '@/lib/places';
import type { TaskPlaceDTO } from '@/lib/types';

// A task's places as names, for the DTO and the dashboard. A task keeps its
// first place in roomId/floorId (with Prisma relations) and any more as plain
// id lists, so the names come from one lookup of the household's floors and
// rooms rather than per-task joins.

type Db = Prisma.TransactionClient | typeof prisma;

export interface PlaceIndex {
  floors: Map<string, { id: string; name: string; position: number }>;
  rooms: Map<string, { id: string; name: string; floorId: string | null; position: number }>;
}

export async function loadPlaceIndex(db: Db, householdId: string): Promise<PlaceIndex> {
  const [floors, rooms] = await Promise.all([
    db.floor.findMany({ where: { householdId }, select: { id: true, name: true, position: true } }),
    db.room.findMany({ where: { householdId }, select: { id: true, name: true, floorId: true, position: true } }),
  ]);
  return {
    floors: new Map(floors.map((f) => [f.id, f])),
    rooms: new Map(rooms.map((r) => [r.id, r])),
  };
}

/**
 * A task's places with names, in the household's order: floors in their
 * order (a whole floor before its rooms), then rooms on no floor. Places
 * that no longer exist are left out; [] = the whole house.
 */
export function resolveTaskPlaces(
  row: { roomId: string | null; floorId: string | null; extraRoomIds?: string[] | null; extraFloorIds?: string[] | null },
  index: PlaceIndex,
): TaskPlaceDTO[] {
  const ref = (p: { id: string; name: string }) => ({ id: p.id, name: p.name });
  const placed = taskPlaceIds(row).flatMap((p): { key: number[]; place: TaskPlaceDTO }[] => {
    if (p.roomId) {
      const room = index.rooms.get(p.roomId);
      if (!room) return [];
      const floor = room.floorId ? index.floors.get(room.floorId) : undefined;
      const key = [floor ? floor.position : Number.MAX_SAFE_INTEGER, 1, room.position];
      return [{ key, place: { room: ref(room), floor: floor ? ref(floor) : null } }];
    }
    const floor = p.floorId ? index.floors.get(p.floorId) : undefined;
    return floor ? [{ key: [floor.position, 0, 0], place: { room: null, floor: ref(floor) } }] : [];
  });
  placed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return placed.map((p) => p.place);
}
