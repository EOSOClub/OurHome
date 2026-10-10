import { describe, expect, it } from 'vitest';
import { groupByPlace, moveId, orderTasks, placeLabel, type PlacedTask } from '@/lib/places';

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
