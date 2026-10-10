import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { NotFoundError } from '@/server/services/errors';
import { assertPlaceRef } from '@/server/services/householdRefs';
import { byPosition } from '@/lib/places';
import type { PlacesDTO } from '@/lib/types';
import type {
  DeletePlaceInput,
  ReorderPlacesInput,
  SaveFloorInput,
  SaveRoomInput,
} from '@/lib/validation/place';

// Floors and the rooms on them, set up in Settings → Rooms & floors. Tasks
// point at one room or a whole floor (taskService); grouping and order rules
// are in src/lib/places.ts.

export async function listPlaces(householdId: string): Promise<PlacesDTO> {
  const [floors, rooms] = await Promise.all([
    prisma.floor.findMany({ where: { householdId } }),
    prisma.room.findMany({ where: { householdId } }),
  ]);
  return {
    floors: floors
      .map((f) => ({ id: f.id, name: f.name, position: f.position }))
      .sort(byPosition),
    rooms: rooms
      .map((r) => ({ id: r.id, name: r.name, floorId: r.floorId ?? null, position: r.position }))
      .sort(byPosition),
  };
}

/** After the last one, so a new floor or room lands at the end. */
async function nextPosition(kind: 'floor' | 'room', householdId: string, floorId: string | null) {
  const rows =
    kind === 'floor'
      ? await prisma.floor.findMany({ where: { householdId }, select: { position: true } })
      : await prisma.room.findMany({
          where: { householdId, ...(floorId ? { floorId } : { OR: [{ floorId: null }, { floorId: { isSet: false } }] }) },
          select: { position: true },
        });
  return rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
}

export async function saveFloor(householdId: string, actorId: string, input: SaveFloorInput): Promise<PlacesDTO> {
  if (input.id) {
    const existing = await prisma.floor.findFirst({ where: { id: input.id, householdId } });
    if (!existing) throw new NotFoundError('Floor not found.');
    await prisma.floor.update({ where: { id: input.id }, data: { name: input.name } });
    if (existing.name !== input.name) {
      await logActivity({
        householdId,
        actorId,
        verb: 'updated',
        subjectType: 'floor',
        subjectId: input.id,
        message: `renamed the floor “${existing.name}” to “${input.name}”`,
      });
    }
  } else {
    const floor = await prisma.floor.create({
      data: { householdId, name: input.name, position: await nextPosition('floor', householdId, null) },
    });
    await logActivity({
      householdId,
      actorId,
      verb: 'created',
      subjectType: 'floor',
      subjectId: floor.id,
      message: `added the floor “${floor.name}”`,
    });
  }
  return listPlaces(householdId);
}

export async function saveRoom(householdId: string, actorId: string, input: SaveRoomInput): Promise<PlacesDTO> {
  await assertPlaceRef(prisma, householdId, null, input.floorId);
  if (input.id) {
    const existing = await prisma.room.findFirst({ where: { id: input.id, householdId } });
    if (!existing) throw new NotFoundError('Room not found.');
    const floorId = input.floorId === undefined ? (existing.floorId ?? null) : input.floorId;
    const moved = floorId !== (existing.floorId ?? null);
    await prisma.room.update({
      where: { id: input.id },
      data: {
        name: input.name,
        floorId,
        // Moved to another floor: last there.
        ...(moved ? { position: await nextPosition('room', householdId, floorId) } : {}),
      },
    });
    // Its tasks keep pointing at the room; their floor follows the room's.
    if (existing.name !== input.name || moved) {
      await logActivity({
        householdId,
        actorId,
        verb: 'updated',
        subjectType: 'room',
        subjectId: input.id,
        message:
          existing.name !== input.name
            ? `renamed the room “${existing.name}” to “${input.name}”`
            : `moved the room “${input.name}” to another floor`,
      });
    }
  } else {
    const floorId = input.floorId ?? null;
    const room = await prisma.room.create({
      data: { householdId, name: input.name, floorId, position: await nextPosition('room', householdId, floorId) },
    });
    await logActivity({
      householdId,
      actorId,
      verb: 'created',
      subjectType: 'room',
      subjectId: room.id,
      message: `added the room “${room.name}”`,
    });
  }
  return listPlaces(householdId);
}

/**
 * Delete a room: its tasks move up to its floor (or the whole house). Delete
 * a floor: its rooms stay, on no floor; its whole-floor tasks go to the whole
 * house. Nothing else is lost.
 */
export async function deletePlace(householdId: string, actorId: string, input: DeletePlaceInput): Promise<PlacesDTO> {
  if (input.kind === 'room') {
    const room = await prisma.room.findFirst({ where: { id: input.id, householdId } });
    if (!room) throw new NotFoundError('Room not found.');
    await prisma.$transaction([
      prisma.task.updateMany({
        where: { householdId, roomId: room.id },
        data: { roomId: null, floorId: room.floorId ?? null },
      }),
      prisma.room.delete({ where: { id: room.id } }),
    ]);
    await logActivity({
      householdId,
      actorId,
      verb: 'deleted',
      subjectType: 'room',
      subjectId: room.id,
      message: `removed the room “${room.name}”`,
    });
  } else {
    const floor = await prisma.floor.findFirst({ where: { id: input.id, householdId } });
    if (!floor) throw new NotFoundError('Floor not found.');
    await prisma.$transaction([
      prisma.task.updateMany({ where: { householdId, floorId: floor.id }, data: { floorId: null } }),
      prisma.room.updateMany({ where: { householdId, floorId: floor.id }, data: { floorId: null } }),
      prisma.floor.delete({ where: { id: floor.id } }),
    ]);
    await logActivity({
      householdId,
      actorId,
      verb: 'deleted',
      subjectType: 'floor',
      subjectId: floor.id,
      message: `removed the floor “${floor.name}” (its rooms are kept)`,
    });
  }
  return listPlaces(householdId);
}

/** Positions = array index. Ids not in the household are ignored. */
export async function reorderPlaces(householdId: string, input: ReorderPlacesInput): Promise<PlacesDTO> {
  await prisma.$transaction(
    input.ids.map((id, position) =>
      input.kind === 'floor'
        ? prisma.floor.updateMany({ where: { id, householdId }, data: { position } })
        : prisma.room.updateMany({ where: { id, householdId }, data: { position } }),
    ),
  );
  return listPlaces(householdId);
}
