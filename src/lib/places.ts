// Floors and rooms: how tasks (and inventory items, which have no hand-set
// position) are grouped by place and kept in the order the household set.
// Pure, shared by the Tasks and Inventory pages and mirrored in the Android
// app (data/Places.kt) - change both together.

export interface FloorRef {
  id: string;
  name: string;
  position: number;
}

export interface RoomRef {
  id: string;
  name: string;
  floorId: string | null;
  position: number;
}

/** One place: a room (with its floor), or a whole floor (room null). */
export interface PlaceRefs<P = { id: string }> {
  room: P | null;
  floor: P | null;
}

/** What a task needs for grouping: its place(s) and hand-set position. */
export interface PlacedTask {
  room: { id: string } | null;
  /** The task's own floor (a whole-floor task), or its room's floor. */
  floor: { id: string } | null;
  /**
   * Every place it's done in, when it can have several (tasks). Absent =
   * just room/floor above (inventory items).
   */
  places?: PlaceRefs[];
  position: number | null;
}

/** A place as stored: a room, else a whole floor. */
export interface PlaceIds {
  roomId: string | null;
  floorId: string | null;
}

const placeKey = (p: PlaceIds) => (p.roomId ? `room:${p.roomId}` : `floor:${p.floorId}`);

function uniquePlaces(list: PlaceIds[]): PlaceIds[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const key = placeKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every place of a task as stored: the first in roomId/floorId, then the
 * extra rooms and floors. [] = the whole house.
 */
export function taskPlaceIds(row: {
  roomId: string | null;
  floorId: string | null;
  extraRoomIds?: string[] | null;
  extraFloorIds?: string[] | null;
}): PlaceIds[] {
  return uniquePlaces([
    ...(row.roomId || row.floorId ? [placeColumns(row.roomId, row.floorId)] : []),
    ...(row.extraRoomIds ?? []).map((roomId) => ({ roomId, floorId: null })),
    ...(row.extraFloorIds ?? []).map((floorId) => ({ roomId: null, floorId })),
  ]);
}

/**
 * The stored columns for a task's places: the first goes in roomId/floorId
 * (what app builds that know one place read), the rest in the extra lists.
 * Duplicates are dropped; [] = the whole house.
 */
export function placeListColumns(list: PlaceIds[]) {
  const [first, ...rest] = uniquePlaces(
    list.map((p) => placeColumns(p.roomId, p.floorId)).filter((p) => p.roomId || p.floorId),
  );
  return {
    ...(first ?? { roomId: null, floorId: null }),
    extraRoomIds: rest.flatMap((p) => (p.roomId ? [p.roomId] : [])),
    extraFloorIds: rest.flatMap((p) => (p.roomId ? [] : [p.floorId!])),
  };
}

/** True when both lists hold the same places, in any order. */
export function samePlaces(a: PlaceIds[], b: PlaceIds[]): boolean {
  const keys = new Set(uniquePlaces(a).map(placeKey));
  const other = uniquePlaces(b);
  return keys.size === other.length && other.every((p) => keys.has(placeKey(p)));
}

/** By hand-set position, then name - floors and rooms alike. */
export function byPosition<T extends { position: number; name: string }>(a: T, b: T): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

/**
 * Tasks in their hand-set order: positioned ones first (by position), then
 * the rest in the order given (the server's due-date order). Stable.
 */
export function orderTasks<T extends PlacedTask>(tasks: T[]): T[] {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const pa = a.t.position;
      const pb = b.t.position;
      if (pa !== null && pb !== null && pa !== pb) return pa - pb;
      if (pa !== null && pb === null) return -1;
      if (pa === null && pb !== null) return 1;
      return a.i - b.i;
    })
    .map(({ t }) => t);
}

export interface RoomGroup<T> {
  room: RoomRef;
  tasks: T[];
}

export interface FloorGroup<T> {
  /** null = rooms that aren't on any floor. */
  floor: FloorRef | null;
  /** Whole-floor tasks (none for the no-floor group). */
  tasks: T[];
  rooms: RoomGroup<T>[];
}

export interface PlaceGroups<T> {
  floors: FloorGroup<T>[];
  /** Tasks with no room or floor: the whole house. */
  house: T[];
}

/**
 * Tasks grouped Floor → Room in the household's order. Floors come first in
 * their order, then rooms on no floor, then whole-house tasks. A task with
 * several places is listed under each of them. Empty rooms and floors are
 * left out; a task none of whose places still exist counts as whole-house.
 */
export function groupByPlace<T extends PlacedTask>(
  tasks: T[],
  floors: FloorRef[],
  rooms: RoomRef[],
): PlaceGroups<T> {
  const roomIds = new Set(rooms.map((r) => r.id));
  const floorIds = new Set(floors.map((f) => f.id));
  const inRoom = new Map<string, T[]>();
  const onFloor = new Map<string, T[]>();
  const house: T[] = [];
  const add = (map: Map<string, T[]>, id: string, t: T) => {
    const list = map.get(id) ?? [];
    if (!list.includes(t)) map.set(id, [...list, t]);
  };
  for (const t of orderTasks(tasks)) {
    const places = t.places ?? [{ room: t.room, floor: t.floor }];
    let placed = false;
    for (const p of places) {
      if (p.room && roomIds.has(p.room.id)) {
        add(inRoom, p.room.id, t);
        placed = true;
      } else if (!p.room && p.floor && floorIds.has(p.floor.id)) {
        add(onFloor, p.floor.id, t);
        placed = true;
      }
    }
    if (!placed) house.push(t);
  }

  const roomGroups = (floorId: string | null) =>
    rooms
      .filter((r) => (r.floorId && floorIds.has(r.floorId) ? r.floorId : null) === floorId)
      .sort(byPosition)
      .flatMap((room) => {
        const list = inRoom.get(room.id);
        return list?.length ? [{ room, tasks: list }] : [];
      });

  const groups: FloorGroup<T>[] = [...floors].sort(byPosition).flatMap((floor) => {
    const group = { floor, tasks: onFloor.get(floor.id) ?? [], rooms: roomGroups(floor.id) };
    return group.tasks.length || group.rooms.length ? [group] : [];
  });
  const loose = roomGroups(null);
  if (loose.length) groups.push({ floor: null, tasks: [], rooms: loose });
  return { floors: groups, house };
}

/** `ids` with `id` moved one step up (-1) or down (+1); unchanged at an end. */
export function moveId(ids: string[], id: string, direction: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The stored columns for a place: a room, else a whole floor, else neither. */
export function placeColumns(roomId: string | null | undefined, floorId: string | null | undefined) {
  return roomId ? { roomId, floorId: null } : { roomId: null, floorId: floorId ?? null };
}

/** A room's floor comes from the room, so moving a room moves what's in it. */
export function placeRefs(row: {
  room: { id: string; name: string; floor: { id: string; name: string } | null } | null;
  floor: { id: string; name: string } | null;
}): { room: { id: string; name: string } | null; floor: { id: string; name: string } | null } {
  const ref = (p: { id: string; name: string } | null) => (p ? { id: p.id, name: p.name } : null);
  return { room: ref(row.room), floor: row.room ? ref(row.room.floor) : ref(row.floor) };
}

/** "Upstairs · Bedroom", "Upstairs", "Kitchen" - a task's place as one label. */
export function placeLabel(task: {
  room: { name: string } | null;
  floor: { name: string } | null;
}): string | null {
  if (task.room) return task.floor ? `${task.floor.name} · ${task.room.name}` : task.room.name;
  return task.floor?.name ?? null;
}

/**
 * Every place of a task as one label. One place reads as placeLabel; several
 * share their floor: "Ground floor · Kitchen, Laundry; Upstairs".
 */
export function placesLabel(task: {
  room: { name: string } | null;
  floor: { name: string } | null;
  places?: PlaceRefs<{ name: string }>[];
}): string | null {
  const list = task.places ?? [{ room: task.room, floor: task.floor }];
  if (list.length <= 1) return list[0] ? placeLabel(list[0]) : null;
  // Per floor (null = rooms on no floor), in the order they come.
  const parts = new Map<string | null, { whole: boolean; rooms: string[] }>();
  for (const p of list) {
    const key = p.floor?.name ?? null;
    const part = parts.get(key) ?? { whole: false, rooms: [] };
    if (p.room) part.rooms.push(p.room.name);
    else part.whole = true;
    parts.set(key, part);
  }
  const labels = [...parts].flatMap(([floor, part]) => [
    ...(part.whole && floor ? [floor] : []),
    ...(part.rooms.length ? [floor ? `${floor} · ${part.rooms.join(', ')}` : part.rooms.join(', ')] : []),
  ]);
  return labels.length ? labels.join('; ') : null;
}
