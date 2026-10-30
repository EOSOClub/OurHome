import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// GET /api/tasks/submissions/photo (Task Photo Proof): the photo is only ever
// served as a private, sandboxed JPEG, and anyone the service refuses gets the
// same 404 as for a photo that doesn't exist.

const user = { id: 'adult1', householdId: 'household1', role: 'adult' };
vi.mock('@/server/auth/session', () => ({ getServerSession: vi.fn(async () => ({ user })) }));
vi.mock('@/server/services/serverAdminService', () => ({
  HOUSEHOLD_DISABLED_MESSAGE: 'off',
  isHouseholdDisabled: vi.fn(async () => false),
  isFeatureEnabled: vi.fn(async () => true),
  isServerAdmin: vi.fn(async () => false),
}));
vi.mock('@/server/services/permissionService', () => ({ getUserAccess: vi.fn() }));
const { NotFoundError } = await import('@/server/services/errors');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const submissions = {
  submissionPhoto: vi.fn(async (_hh: string, _viewer: string, _id: string): Promise<Uint8Array> => JPEG),
};
vi.mock('@/server/services/taskSubmissionService', () => submissions);

const { GET } = await import('@/app/api/tasks/submissions/photo/route');

const ID = 'cmabcdefghijklmnopqrstuvw';
function get(id: string) {
  return GET(
    new NextRequest(`http://localhost/api/tasks/submissions/photo?id=${encodeURIComponent(id)}`, {
      headers: { 'cf-connecting-ip': 'ip-photo' },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/tasks/submissions/photo', () => {
  it('serves the JPEG privately and sandboxed, asking the service as the signed-in member', async () => {
    const res = await get(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(submissions.submissionPhoto).toHaveBeenCalledWith('household1', 'adult1', ID);
  });

  it('answers 404 when the service refuses (not theirs to see, or no photo)', async () => {
    submissions.submissionPhoto.mockRejectedValueOnce(new NotFoundError('No photo for that check.'));
    const res = await get(ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { message: 'No photo for that check.' } });
  });

  it('refuses an id that is not an id (422) without asking the service', async () => {
    const res = await get('not an id!');
    expect(res.status).toBe(422);
    expect(submissions.submissionPhoto).not.toHaveBeenCalled();
  });
});
