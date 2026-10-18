import type { NextRequest } from 'next/server';
import { clientIp, fail, rateLimit } from '@/server/api/http';
import { apkDownloadResponse } from '@/server/services/appDownloadService';
import { resolveSetupLink } from '@/server/services/setupLinkService';

// The Android app for a child's phone that isn't signed in yet: public, but
// only with a setup link's token (?token=), which the Head of House made in
// Set up a child. Same file as ../download.
export const GET = async (req: NextRequest) => {
  if (!rateLimit(`setup-download:${clientIp(req)}`, 60_000, 20)) return fail('Too many requests', 429);
  const link = await resolveSetupLink(req.nextUrl.searchParams.get('token') ?? '');
  if (!link) return fail('This setup link has ended. Ask for a new one.', 404);
  return apkDownloadResponse() ?? fail("The Android app isn't built on this server.", 404);
};
