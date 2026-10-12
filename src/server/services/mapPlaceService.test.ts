import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  mapPlace: {
    findMany: vi.fn(async (): Promise<unknown[]> => []),
    findFirst: vi.fn(),
    create: vi.fn(async (args: { data: { name: string } }) => ({ id: 'new', ...args.data })),
    update: vi.fn(),
    delete: vi.fn(),
  },
  shoppingList: { findMany: vi.fn(async (): Promise<{ id: string }[]> => []) },
  memberLocation: { updateMany: vi.fn((args: unknown) => args) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
const pushSync = vi.fn();
vi.mock('@/server/services/pushService', () => ({ pushSync }));

const { deleteMapPlace, listMapPlaces, parseNominatim, saveMapPlace } = await import('./mapPlaceService');

const base = { name: 'Costco', kind: 'store' as const, lat: 41.9, lng: -87.7, radiusM: 250, shoppingListIds: [] };
const listA = 'clist0000000000000000000a';
const listB = 'clist0000000000000000000b';

describe('mapPlaceService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists home first and drops shopping lists deleted since', async () => {
    prisma.mapPlace.findMany.mockResolvedValueOnce([
      { id: 's', name: 'Aldi', kind: 'store', lat: 1, lng: 2, radiusM: 150, shoppingListIds: [listA, listB] },
      { id: 'h', name: 'Our house', kind: 'home', lat: 1, lng: 2, radiusM: 150, shoppingListIds: [] },
    ]);
    prisma.shoppingList.findMany.mockResolvedValueOnce([{ id: listA }]);
    const places = await listMapPlaces('h1');
    expect(places.map((p) => p.id)).toEqual(['h', 's']);
    expect(places[1].shoppingListIds).toEqual([listA]);
  });

  it('refuses a second home', async () => {
    prisma.mapPlace.findFirst.mockResolvedValueOnce({ name: 'Our house' });
    await expect(saveMapPlace('h1', 'u1', { ...base, kind: 'home', name: 'Cabin' })).rejects.toThrow(
      /already the home/,
    );
    expect(prisma.mapPlace.create).not.toHaveBeenCalled();
  });

  it('refuses another household’s shopping list', async () => {
    prisma.shoppingList.findMany.mockResolvedValueOnce([]);
    await expect(saveMapPlace('h1', 'u1', { ...base, shoppingListIds: [listA] })).rejects.toThrow(/not found/);
  });

  it('keeps lists only on stores', async () => {
    await saveMapPlace('h1', 'u1', { ...base, kind: 'other', name: 'School', shoppingListIds: [listA] });
    // Only the final re-list reads lists; the ids sent were never looked up.
    const lookedUp = prisma.shoppingList.findMany.mock.calls as unknown as [{ where: { id?: unknown } }][];
    expect(lookedUp.some(([a]) => a.where.id)).toBe(false);
    expect(prisma.mapPlace.create.mock.calls[0][0].data).toMatchObject({ kind: 'other', shoppingListIds: [], createdById: 'u1' });
  });

  it('wakes the phones when places change', async () => {
    await saveMapPlace('h1', 'u1', { ...base, kind: 'other', name: 'School' });
    expect(pushSync).toHaveBeenCalledWith('h1', { everyone: true }, 'map_places');
  });

  it('makes anyone at a deleted place away', async () => {
    prisma.mapPlace.findFirst.mockResolvedValueOnce({ id: 'p1', name: 'Gym' });
    await deleteMapPlace('h1', 'u1', { id: 'cplace000000000000000000a' });
    expect(prisma.memberLocation.updateMany).toHaveBeenCalledWith({
      where: { householdId: 'h1', placeId: 'p1' },
      data: { state: 'away', placeId: null },
    });
    expect(pushSync).toHaveBeenCalledWith('h1', { everyone: true }, 'map_places');
  });

  it('reads Nominatim answers and skips malformed hits', () => {
    expect(
      parseNominatim([
        { display_name: '1 Main St', lat: '41.5', lon: '-87.25' },
        { display_name: 'no coords' },
        { lat: '1', lon: '2' },
      ]),
    ).toEqual([{ label: '1 Main St', lat: 41.5, lng: -87.25 }]);
    expect(parseNominatim({ error: 'nope' })).toEqual([]);
  });
});
