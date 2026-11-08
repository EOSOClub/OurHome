import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stock changes: the result stays within 0..the cap, and float leftovers
// (0.1 + 0.2) never reach the item or the Activity text.

vi.mock('@/server/db/prisma', () => ({ prisma: {} }));
const activity = { logActivity: vi.fn() };
vi.mock('@/server/services/activityService', () => activity);
vi.mock('@/server/services/householdRefs', () => ({ assertCategoryRef: vi.fn(), assertPlaceRef: vi.fn() }));

const { adjustQuantity, roundQuantity } = await import('./inventoryService');

const H = 'h1';
let row: Record<string, unknown>;
const db = {
  inventoryItem: {
    findFirst: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(row, data);
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
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
