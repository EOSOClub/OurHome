import { fail, withAuth } from '@/server/api/http';
import { apkDownloadResponse } from '@/server/services/appDownloadService';

// The Android app built by the deploy, for signed-in members only (the
// Profile page links here). Streams the APK; 404 when none is built. A
// child's phone without an account yet uses ../setup-download instead.
export const GET = withAuth(async () => {
  return apkDownloadResponse() ?? fail("The Android app isn't built on this server.", 404);
});
