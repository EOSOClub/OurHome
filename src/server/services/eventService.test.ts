import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tags by tagId, with the household's unique (householdId, tagId) index.
let tags: Map<string, { tagId: string; config: string | null }>;
const clash = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const prisma = {
  nfcTag: {
    findUnique: vi.fn(async (args: { where: { householdId_tagId: { tagId: string } } }) =>
      tags.get(args.where.householdId_tagId.tagId) ?? null,
    ),
    create: vi.fn(async (args: { data: { tagId: string; config: string } }) => {
      if (tags.has(args.data.tagId)) throw clash();
      tags.set(args.data.tagId, { tagId: args.data.tagId, config: args.data.config });
      return tags.get(args.data.tagId);
    }),
    deleteMany: vi.fn(async (args: { where: { tagId: string; config: string } }) => {
      if (tags.get(args.where.tagId)?.config === args.where.config) tags.delete(args.where.tagId);
      return { count: 1 };
    }),
  },
  user: { findFirst: vi.fn(async () => null) },
  eventLog: { create: vi.fn() },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

let items: { id: string; name: string; quantity: number }[];
const inventory = {
  createInventoryItem: vi.fn(async (_h: string, _u: string | null, input: { name: string; quantity: number }) => {
    const item = { id: `item${items.length + 1}`, name: input.name, quantity: input.quantity };
    items.push(item);
    return item;
  }),
  findItemInHousehold: vi.fn(async (id: string) => items.find((i) => i.id === id)!),
  adjustQuantity: vi.fn(),
  itemToDTO: vi.fn((item: { id: string }) => item),
};
vi.mock('@/server/services/inventoryService', () => inventory);
vi.mock('@/server/services/nfcService', () => ({
  parseTagItemId: (tag: { config: string | null }) => (JSON.parse(tag.config ?? '{}') as { itemId?: string }).itemId ?? null,
  registerNfcTag: vi.fn(async (_h: string, _u: string | null, input: { tagId: string; itemId: string }) => {
    tags.set(input.tagId, { tagId: input.tagId, config: JSON.stringify({ itemId: input.itemId }) });
  }),
}));

const { ingestNfcScan } = await import('./eventService');

const SCAN = { tagId: 'coffee', amount: 3, name: 'Coffee' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  tags = new Map();
  items = [];
});

describe('the first scan of an unknown tag', () => {
  it('two scans at once make one item, and both get it', async () => {
    // Both scans read the tag before either set it up.
    prisma.nfcTag.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const first = await ingestNfcScan('h1', SCAN);
    const second = await ingestNfcScan('h1', SCAN);
    expect(inventory.createInventoryItem).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('while the other scan is still setting it up: try again, nothing made', async () => {
    tags.set('coffee', { tagId: 'coffee', config: '{}' });
    prisma.nfcTag.findUnique.mockResolvedValueOnce(null);
    await expect(ingestNfcScan('h1', SCAN)).rejects.toThrow('Scan it again');
    expect(inventory.createInventoryItem).not.toHaveBeenCalled();
  });

  it('a failed setup lets go of the tag for the next scan', async () => {
    inventory.createInventoryItem.mockRejectedValueOnce(new Error('down'));
    await expect(ingestNfcScan('h1', SCAN)).rejects.toThrow('down');
    expect(tags.has('coffee')).toBe(false);
    await ingestNfcScan('h1', SCAN);
    expect(items).toHaveLength(1);
  });
});
