import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner decision 2026-11-08: changing what a tag scan does needs edit access
// to Inventory. A view-only member can still scan (the scan routes keep
// requireAnyAccess), but not change the tag's settings.

const calls: string[] = [];
const requireModify = vi.fn(async () => {
  calls.push('requireModify');
});
const requireAnyAccess = vi.fn(async () => {
  calls.push('requireAnyAccess');
});
vi.mock('@/server/api/http', () => ({
  withAuth: (handler: (ctx: unknown) => unknown) => handler,
  ok: (body: unknown) => body,
  parseBody: vi.fn(async () => {
    calls.push('parseBody');
    return { tagId: 'trash_can', scanAction: 'notify' };
  }),
  requireModify,
  requireAnyAccess,
}));
const updateTagSettings = vi.fn(async () => {
  calls.push('updateTagSettings');
  return { tagId: 'trash_can' };
});
vi.mock('@/server/services/nfcService', () => ({ updateTagSettings }));

const { POST } = await import('./route');
const ctx = { req: {}, user: { id: 'u1', householdId: 'h1' } };

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/nfc/tags/settings', () => {
  it('asks for Inventory edit access (a tag has no owner, so "edit others") before changing anything', async () => {
    await (POST as unknown as (c: typeof ctx) => Promise<unknown>)(ctx);
    expect(requireModify).toHaveBeenCalledWith(ctx, 'inventory', 'edit', null);
    expect(requireAnyAccess).not.toHaveBeenCalled();
    expect(calls.indexOf('requireModify')).toBeLessThan(calls.indexOf('updateTagSettings'));
  });

  it('a view-only member is refused and nothing changes', async () => {
    requireModify.mockRejectedValueOnce(new Error('You can’t edit other people’s items on Inventory.'));
    await expect((POST as unknown as (c: typeof ctx) => Promise<unknown>)(ctx)).rejects.toThrow();
    expect(updateTagSettings).not.toHaveBeenCalled();
  });
});
