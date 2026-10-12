import { describe, expect, it } from 'vitest';
import {
  groupByPlace,
  moveId,
  orderTasks,
  placeColumns,
  placeLabel,
  placeListColumns,
  placeRefs,
  placesLabel,
  samePlaces,
  taskPlaceIds,
  type PlacedTask,
} from '@/lib/places';

describe('placeColumns', () => {
  it('stores a room, else a whole floor, else neither', () => {
    expect(placeColumns('r1', 'f1')).toEqual({ roomId: 'r1', floorId: null });
    expect(placeColumns(null, 'f1')).toEqual({ roomId: null, floorId: 'f1' });
    expect(placeColumns(undefined, undefined)).toEqual({ roomId: null, floorId: null });
  });
});

describe('placeRefs', () => {
  const up = { id: 'f1', name: 'Upstairs' };
  it("takes a room's floor from the room", () => {
    expect(placeRefs({ room: { id: 'r1', name: 'Bath', floor: up }, floor: { id: 'f2', name: 'Old' } })).toEqual({
      room: { id: 'r1', name: 'Bath' },
      floor: up,
    });
    expect(placeRefs({ room: { id: 'r1', name: 'Bath', floor: null }, floor: null })).toEqual({
      room: { id: 'r1', name: 'Bath' },
      floor: null,
    });
    expect(placeRefs({ room: null, floor: up })).toEqual({ room: null, floor: up });
  });
});

// Same cases as the app's PlacesTest.kt.

const floors = [
  { id: 'up', name: 'Upstairs', position: 1 },
  { id: 'main', name: 'Main', position: 0 },
];
const rooms = [
  { id: 'bath', name: 'Bathroom', floorId: 'up', position: 1 },
  { id: 'bed', name: 'Bedroom', floorId: 'up', position: 0 },
  { id: 'kit', name: 'Kitchen', floorId: 'main', position: 0 },
  { id: 'gar', name: 'Garage', floorId: null, position: 0 },
];

function task(id: string, place: { room?: string; floor?: string } = {}, position: number | null = null) {
  return {
    id,
    room: place.room ? { id: place.room } : null,
    floor: place.floor ? { id: place.floor } : null,
    position,
  } satisfies PlacedTask & { id: string };
}

const ids = (list: { id: string }[]) => list.map((t) => t.id);

describe('orderTasks', () => {
  it('puts hand-ordered tasks first, the rest in the given (due) order', () => {
    const list = [task('a'), task('b', {}, 1), task('c'), task('d', {}, 0)];
    expect(ids(orderTasks(list))).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('groupByPlace', () => {
  const tasks = [
    task('vacuum', { floor: 'up' }),
    task('sheets', { room: 'bed', floor: 'up' }),
    task('scrub', { room: 'bath', floor: 'up' }),
    task('dishes', { room: 'kit', floor: 'main' }),
    task('oil', { room: 'gar' }),
    task('bins'),
    task('ghost', { room: 'deleted-room' }),
  ];
  const g = groupByPlace(tasks, floors, rooms);

  it('orders floors, then rooms on no floor', () => {
    expect(g.floors.map((f) => f.floor?.id ?? null)).toEqual(['main', 'up', null]);
  });

  it('orders rooms within a floor and keeps whole-floor tasks on the floor', () => {
    const up = g.floors[1];
    expect(ids(up.tasks)).toEqual(['vacuum']);
    expect(up.rooms.map((r) => r.room.id)).toEqual(['bed', 'bath']);
  });

  it('sends unplaced tasks and ones pointing at deleted places to the whole house', () => {
    expect(ids(g.house)).toEqual(['bins', 'ghost']);
  });

  it('leaves out empty floors and rooms', () => {
    const only = groupByPlace([task('dishes', { room: 'kit' })], floors, rooms);
    expect(only.floors).toHaveLength(1);
    expect(only.floors[0].rooms.map((r) => r.room.id)).toEqual(['kit']);
  });

  it('lists a task in several places under each of them', () => {
    const mop = {
      ...task('mop', { room: 'kit', floor: 'main' }),
      places: [
        { room: { id: 'kit' }, floor: { id: 'main' } },
        { room: { id: 'bath' }, floor: { id: 'up' } },
        { room: null, floor: { id: 'up' } },
        { room: { id: 'deleted-room' }, floor: null },
      ],
    };
    const multi = groupByPlace([mop, task('dishes', { room: 'kit' })], floors, rooms);
    const [main, up] = multi.floors;
    expect(ids(main.rooms[0].tasks)).toEqual(['mop', 'dishes']);
    expect(ids(up.tasks)).toEqual(['mop']);
    expect(ids(up.rooms[0].tasks)).toEqual(['mop']);
    expect(multi.house).toEqual([]);
  });

  it('sends a task none of whose places exist to the whole house', () => {
    const lost = { ...task('lost'), places: [{ room: { id: 'gone' }, floor: null }] };
    expect(ids(groupByPlace([lost], floors, rooms).house)).toEqual(['lost']);
  });
});

describe('taskPlaceIds and placeListColumns', () => {
  it('reads the first place, then the extra rooms and floors, without repeats', () => {
    expect(taskPlaceIds({ roomId: 'kit', floorId: null, extraRoomIds: ['bath', 'kit'], extraFloorIds: ['up'] })).toEqual([
      { roomId: 'kit', floorId: null },
      { roomId: 'bath', floorId: null },
      { roomId: null, floorId: 'up' },
    ]);
    // Tasks from before several places have no extra lists.
    expect(taskPlaceIds({ roomId: null, floorId: 'up' })).toEqual([{ roomId: null, floorId: 'up' }]);
    expect(taskPlaceIds({ roomId: null, floorId: null })).toEqual([]);
  });

  it('stores the first place where one-place app builds read it, the rest as extras', () => {
    expect(
      placeListColumns([
        { roomId: null, floorId: 'up' },
        { roomId: 'kit', floorId: null },
        { roomId: 'kit', floorId: null },
        { roomId: null, floorId: 'main' },
      ]),
    ).toEqual({ roomId: null, floorId: 'up', extraRoomIds: ['kit'], extraFloorIds: ['main'] });
    expect(placeListColumns([])).toEqual({ roomId: null, floorId: null, extraRoomIds: [], extraFloorIds: [] });
  });

  it('round-trips', () => {
    const list = [
      { roomId: 'kit', floorId: null },
      { roomId: 'bath', floorId: null },
      { roomId: null, floorId: 'up' },
    ];
    expect(taskPlaceIds(placeListColumns(list))).toEqual(list);
  });
});

describe('samePlaces', () => {
  it('ignores order and repeats', () => {
    const a = [{ roomId: 'kit', floorId: null }, { roomId: null, floorId: 'up' }];
    expect(samePlaces(a, [...a].reverse())).toBe(true);
    expect(samePlaces(a, [...a, a[0]])).toBe(true);
    expect(samePlaces(a, a.slice(1))).toBe(false);
    expect(samePlaces([], [])).toBe(true);
  });
});

describe('moveId', () => {
  it('swaps with the neighbour and stops at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('placeLabel', () => {
  it('names the floor and room, either, or nothing', () => {
    expect(placeLabel({ room: { name: 'Bedroom' }, floor: { name: 'Upstairs' } })).toBe('Upstairs · Bedroom');
    expect(placeLabel({ room: { name: 'Garage' }, floor: null })).toBe('Garage');
    expect(placeLabel({ room: null, floor: { name: 'Upstairs' } })).toBe('Upstairs');
    expect(placeLabel({ room: null, floor: null })).toBeNull();
  });
});

describe('placesLabel', () => {
  const up = { name: 'Upstairs' };
  const main = { name: 'Ground floor' };
  it('reads like placeLabel for one place or none', () => {
    expect(placesLabel({ room: { name: 'Bedroom' }, floor: up })).toBe('Upstairs · Bedroom');
    expect(placesLabel({ room: null, floor: null, places: [{ room: { name: 'Garage' }, floor: null }] })).toBe('Garage');
    expect(placesLabel({ room: null, floor: null, places: [] })).toBeNull();
  });
  it('lists several places, sharing each floor', () => {
    expect(
      placesLabel({
        room: null,
        floor: null,
        places: [
          { room: { name: 'Kitchen' }, floor: main },
          { room: { name: 'Laundry' }, floor: main },
          { room: null, floor: up },
          { room: { name: 'Garage' }, floor: null },
        ],
      }),
    ).toBe('Ground floor · Kitchen, Laundry; Upstairs; Garage');
  });
});
