import { beforeEach, describe, expect, it, vi } from 'vitest';

// One shopping item; both ticks below read it before either one is written.
let row: { id: string; name: string; purchased: boolean; purchasedAt: Date | null };
const UNTICKED = { id: 'milk', name: 'Milk', purchased: false, purchasedAt: null, url: null, estimatedPrice: null, list: {} };

const prisma = {
  shoppingItem: {
    findFirst: vi.fn(async () => ({ ...UNTICKED })),
    update: vi.fn(async (args: { data: { purchased: boolean; purchasedAt: Date | null } }) => {
      Object.assign(row, args.data);
      return { ...UNTICKED, ...row };
    }),
    updateMany: vi.fn(async (args: { where: { purchased: boolean }; data: { purchased: boolean } }) => {
      if (row.purchased !== args.where.purchased) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    }),
  },
  purchase: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/linkPreview', () => ({ fetchLinkPreview: vi.fn() }));
vi.mock('@/server/services/householdRefs', () => ({ assertCategoryRef: vi.fn() }));

const { setItemPurchased } = await import('./shoppingService');

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: 'milk', name: 'Milk', purchased: false, purchasedAt: null };
});

describe('ticking off a shopping item', () => {
  it('records one purchase when two people tick it at once', async () => {
    await setItemPurchased('h1', 'u1', { itemId: 'milk', purchased: true });
    await setItemPurchased('h1', 'u2', { itemId: 'milk', purchased: true });
    expect(prisma.purchase.create).toHaveBeenCalledTimes(1);
    expect(row.purchased).toBe(true);
  });

  it('unticking records nothing', async () => {
    row.purchased = true;
    await setItemPurchased('h1', 'u1', { itemId: 'milk', purchased: false });
    expect(prisma.purchase.create).not.toHaveBeenCalled();
    expect(row.purchased).toBe(false);
  });
});
