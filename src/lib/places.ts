// Floors and rooms: how tasks are grouped by place and kept in the order the
// household set. Pure, shared by the Tasks page and mirrored in the Android
// app (data/Places.kt) — change both together.

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

/** What a task needs for grouping: its place and hand-set position. */
export interface PlacedTask {
  room: { id: string } | null;
  /** The task's own floor (a whole-floor task), or its room's floor. */
  floor: { id: string } | null;
  position: number | null;
}

/** By hand-set position, then name — floors and rooms alike. */
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
 * their order, then rooms on no floor, then whole-house tasks. Empty rooms and
 * floors are left out; tasks pointing at a deleted place count as whole-house.
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
  for (const t of orderTasks(tasks)) {
    if (t.room && roomIds.has(t.room.id)) {
      inRoom.set(t.room.id, [...(inRoom.get(t.room.id) ?? []), t]);
    } else if (!t.room && t.floor && floorIds.has(t.floor.id)) {
      onFloor.set(t.floor.id, [...(onFloor.get(t.floor.id) ?? []), t]);
    } else {
      house.push(t);
    }
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

/** "Upstairs · Bedroom", "Upstairs", "Kitchen" — a task's place as one label. */
export function placeLabel(task: {
  room: { name: string } | null;
  floor: { name: string } | null;
}): string | null {
  if (task.room) return task.floor ? `${task.floor.name} · ${task.room.name}` : task.room.name;
  return task.floor?.name ?? null;
}
