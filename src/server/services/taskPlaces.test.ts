import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db/prisma', () => ({ prisma: {} }));

const { resolveTaskPlaces } = await import('./taskPlaces');

const index = {
  floors: new Map([
    ['up', { id: 'up', name: 'Upstairs', position: 1 }],
    ['main', { id: 'main', name: 'Ground floor', position: 0 }],
  ]),
  rooms: new Map([
    ['bath', { id: 'bath', name: 'Bathroom', floorId: 'up', position: 1 }],
    ['bed', { id: 'bed', name: 'Bedroom', floorId: 'up', position: 0 }],
    ['kit', { id: 'kit', name: 'Kitchen', floorId: 'main', position: 0 }],
    ['gar', { id: 'gar', name: 'Garage', floorId: null, position: 0 }],
  ]),
};

describe('resolveTaskPlaces', () => {
  it("names each place in the household's order, a whole floor before its rooms", () => {
    const places = resolveTaskPlaces(
      { roomId: 'gar', floorId: null, extraRoomIds: ['bath', 'bed', 'kit'], extraFloorIds: ['up'] },
      index,
    );
    expect(places).toEqual([
      { room: { id: 'kit', name: 'Kitchen' }, floor: { id: 'main', name: 'Ground floor' } },
      { room: null, floor: { id: 'up', name: 'Upstairs' } },
      { room: { id: 'bed', name: 'Bedroom' }, floor: { id: 'up', name: 'Upstairs' } },
      { room: { id: 'bath', name: 'Bathroom' }, floor: { id: 'up', name: 'Upstairs' } },
      { room: { id: 'gar', name: 'Garage' }, floor: null },
    ]);
  });

  it('leaves out places that no longer exist', () => {
    expect(resolveTaskPlaces({ roomId: 'gone', floorId: null, extraRoomIds: [], extraFloorIds: ['gone-too'] }, index)).toEqual([]);
  });

  it('reads tasks from before several places', () => {
    expect(resolveTaskPlaces({ roomId: null, floorId: 'up' }, index)).toEqual([
      { room: null, floor: { id: 'up', name: 'Upstairs' } },
    ]);
  });
});
