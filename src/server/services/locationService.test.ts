import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = {
  user: {
    findUnique: vi.fn(),
    update: vi.fn(async (args: { data: { locationSharing?: string; liveChecks?: boolean } }) => ({
      locationSharing: args.data.locationSharing ?? null,
      liveChecks: args.data.liveChecks ?? null,
    })),
  },
};
vi.mock('@/server/db/prisma', () => ({ prisma }));

const { updateLocationConsent } = await import('./locationService');

describe('updateLocationConsent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('turns sharing on for the member', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: null, liveChecks: null });
    expect(await updateLocationConsent('u1', { sharing: 'on' })).toEqual({ sharing: 'on', liveChecks: false });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u1' } }));
  });

  it('refuses to turn off sharing that is required', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ locationSharing: 'required', liveChecks: true });
    await expect(updateLocationConsent('u1', { sharing: 'off' })).rejects.toThrow(/required/);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
