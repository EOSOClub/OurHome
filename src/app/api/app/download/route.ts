import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fail, withAuth } from '@/server/api/http';
import { appApkPath, getAppRelease } from '@/server/services/appDownloadService';

// The Android app built by the deploy, for signed-in members only (the
// Profile page links here). Streams the APK; 404 when none is built.
export const GET = withAuth(async () => {
  const release = getAppRelease();
  const apk = appApkPath();
  if (!release || !apk) return fail("The Android app isn't built on this server.", 404);

  const body = Readable.toWeb(createReadStream(apk)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': String(release.sizeBytes),
      'Content-Disposition': `attachment; filename="our-home-${release.versionName}.apk"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
