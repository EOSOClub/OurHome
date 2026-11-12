import { beforeEach, describe, expect, it, vi } from 'vitest';

// What tag setup may change for a member without Inventory "Edit others'"
// (owner, 2026-11-08: changing what a tag does needs it; binding does not).

const findUnique = vi.fn();
vi.mock('@/server/db/prisma', () => ({ prisma: { nfcTag: { findUnique } } }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));

const { limitTagSetup } = await import('./nfcService');

const HH = 'h1';
const bind = { tagId: 'T1', itemId: 'item1', scanAction: 'notify', shoppingListId: 'list2' } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('limitTagSetup', () => {
  it('leaves everything to a member who may change tags', async () => {
    expect(await limitTagSetup(HH, bind, true)).toBe(bind);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('lets anyone set up a new item tag, settings included', async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await limitTagSetup(HH, bind, false)).toBe(bind);
    // Looked up in the caller's household only.
    expect(findUnique.mock.calls[0][0].where).toEqual({ householdId_tagId: { householdId: HH, tagId: 'T1' } });
  });

  it('re-binds an existing tag but keeps its scan action and list', async () => {
    findUnique.mockResolvedValueOnce({ represents: 'consumable', roomId: null });
    const out = await limitTagSetup(HH, bind, false);
    expect(out).toMatchObject({ tagId: 'T1', itemId: 'item1' });
    // registerNfcTag keeps the stored ones when these are left out.
    expect(out.scanAction).toBeUndefined();
    expect(out.shoppingListId).toBeUndefined();
  });

  it('refuses to make a room tag, new or out of an item tag', async () => {
    const room = { tagId: 'T1', roomId: 'room1' } as never;
    findUnique.mockResolvedValueOnce(null);
    await expect(limitTagSetup(HH, room, false)).rejects.toThrow(/can’t change what this tag does/);
    findUnique.mockResolvedValueOnce({ represents: 'consumable', roomId: null });
    await expect(limitTagSetup(HH, room, false)).rejects.toThrow(/can’t change what this tag does/);
  });

  it('refuses to point a room tag at another room, or to turn it into an item tag', async () => {
    findUnique.mockResolvedValueOnce({ represents: 'location', roomId: 'room1' });
    await expect(limitTagSetup(HH, { tagId: 'T1', roomId: 'room2' } as never, false)).rejects.toThrow();
    findUnique.mockResolvedValueOnce({ represents: 'location', roomId: 'room1' });
    await expect(limitTagSetup(HH, bind, false)).rejects.toThrow();
    // Setting it up again for the same room changes nothing: allowed.
    findUnique.mockResolvedValueOnce({ represents: 'location', roomId: 'room1' });
    await expect(limitTagSetup(HH, { tagId: 'T1', roomId: 'room1' } as never, false)).resolves.toBeDefined();
  });
});
