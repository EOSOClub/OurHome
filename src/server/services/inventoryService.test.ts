import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stock changes: the result stays within 0..the cap, and float leftovers
// (0.1 + 0.2) never reach the item or the Activity text.

vi.mock('@/server/db/prisma', () => ({ prisma: {} }));
const activity = { logActivity: vi.fn() };
vi.mock('@/server/services/activityService', () => activity);
vi.mock('@/server/services/householdRefs', () => ({ assertCategoryRef: vi.fn(), assertPlaceRef: vi.fn() }));

const { adjustQuantity, roundQuantity, updateInventoryItem } = await import('./inventoryService');
const { adjustedQuantity } = await import('@/lib/validation/inventory');

const H = 'h1';
let row: Record<string, unknown>;
const db = {
  inventoryItem: {
    findFirst: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      // Like Prisma, a field left undefined is not written.
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      return { ...row };
    }),
  },
};
const adjust = (delta: number) => adjustQuantity(H, 'u1', 'i1', delta, {}, db as never);
const saved = () => db.inventoryItem.updateMany.mock.calls.at(-1)![0].data.quantity;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: 'i1',
    name: 'Flour',
    unit: 'lbs',
    quantity: 0.3,
    lowThreshold: 0,
    isLow: false,
    reorderIntervalDays: null,
    lastRestockedAt: null,
  };
});

describe('roundQuantity', () => {
  it('drops float leftovers and keeps what people enter', () => {
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
    expect(roundQuantity(0.3 - 0.1)).toBe(0.2);
    expect(roundQuantity(0.0625)).toBe(0.0625);
    expect(roundQuantity(2.5)).toBe(2.5);
    expect(roundQuantity(1_000_000)).toBe(1_000_000);
  });

  it('the page shows the number the server will store while a +/- is on its way', () => {
    expect(adjustedQuantity(0.1, 0.2)).toBe(0.3);
    expect(adjustedQuantity(0.3, -5)).toBe(0);
    expect(adjustedQuantity(999_999, 10)).toBe(1_000_000);
  });
});

describe('updateInventoryItem', () => {
  const edit = (input: Record<string, unknown>) =>
    updateInventoryItem(H, 'u1', { itemId: 'i1', ...input } as never, db as never);

  it('a rename racing a scan leaves the Low flag matching the stored amount', async () => {
    row = { ...row, quantity: 5, lowThreshold: 2, isLow: false };
    // A scan takes it to 1 between the edit's read and its write: the first
    // write finds the amount it read gone and writes nothing.
    db.inventoryItem.updateMany.mockImplementationOnce(async () => {
      row.quantity = 1;
      row.isLow = true;
      return { count: 0 };
    });
    await edit({ name: 'Bread flour' });
    expect(row).toMatchObject({ name: 'Bread flour', quantity: 1, isLow: true });
    expect(db.inventoryItem.updateMany).toHaveBeenCalledTimes(2);
    // The write is tied to the amount it worked the flag out from.
    expect(db.inventoryItem.updateMany.mock.calls[1][0]).toMatchObject({ where: { id: 'i1', quantity: 1 } });
  });

  it('a typed amount is written as it is, with its own flag', async () => {
    row = { ...row, quantity: 5, lowThreshold: 2, isLow: false };
    await edit({ quantity: 2 });
    expect(row).toMatchObject({ quantity: 2, isLow: true });
    expect(db.inventoryItem.updateMany).not.toHaveBeenCalled();
  });

  it('gives up with a plain message if the amount keeps changing', async () => {
    db.inventoryItem.updateMany.mockImplementation(async () => ({ count: 0 }));
    await expect(edit({ name: 'Bread flour' })).rejects.toThrow('changed at the same moment');
    db.inventoryItem.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
      return { count: 1 };
    });
  });
});

describe('adjustQuantity', () => {
  it('stores and reports a clean number after a fractional change', async () => {
    await adjust(-0.1);
    expect(saved()).toBe(0.2);
    expect(activity.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'consumed 0.1 lbs of “Flour” (now 0.2)' }),
      db,
    );
  });

  it('never goes below empty or past the most an item can hold', async () => {
    await adjust(-5);
    expect(saved()).toBe(0);
    row.quantity = 999_999;
    await adjust(10);
    expect(saved()).toBe(1_000_000);
  });
});
