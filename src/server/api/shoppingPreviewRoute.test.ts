import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { FULL_ACCESS, NO_ACCESS, type AccessMatrix } from '@/lib/permissions';

// POST /api/shopping/items/preview fills in the Add item form and the edit
// row from a link, so only someone with some Shopping access may make the
// server fetch a page.

const user = { id: 'cmguest00000000000000000001', householdId: 'household1', role: 'guest' };
vi.mock('@/server/auth/session', () => ({ getServerSession: vi.fn(async () => ({ user })) }));
vi.mock('@/server/services/serverAdminService', () => ({
  HOUSEHOLD_DISABLED_MESSAGE: 'off',
  isHouseholdDisabled: vi.fn(async () => false),
  isFeatureEnabled: vi.fn(async () => true),
  isServerAdmin: vi.fn(async () => false),
}));
let access: AccessMatrix = NO_ACCESS;
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn(async () => access) }));
const fetchLinkPreview = vi.fn(async () => ({ title: 'Milk' }));
vi.mock('@/server/services/linkPreview', () => ({ fetchLinkPreview }));

const { POST } = await import('@/app/api/shopping/items/preview/route');

function preview() {
  return POST(
    new NextRequest('http://localhost/api/shopping/items/preview', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/milk' }),
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': 'ip-preview' },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/shopping/items/preview', () => {
  it('refuses someone with no Shopping access, before fetching anything', async () => {
    access = NO_ACCESS;
    expect((await preview()).status).toBe(403);
    expect(fetchLinkPreview).not.toHaveBeenCalled();
  });

  it('lets someone who may only edit items preview a link (the edit row uses it)', async () => {
    access = { ...NO_ACCESS, shopping: { ...NO_ACCESS.shopping, editOwn: true } };
    expect((await preview()).status).toBe(200);
    expect(fetchLinkPreview).toHaveBeenCalledWith('https://example.com/milk');
  });

  it('still previews for someone who may add items', async () => {
    access = FULL_ACCESS;
    expect((await preview()).status).toBe(200);
  });
});
