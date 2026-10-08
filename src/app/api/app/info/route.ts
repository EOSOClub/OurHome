import { ok, withAuth } from '@/server/api/http';
import { getAppRelease } from '@/server/services/appDownloadService';

// The Android app this server offers (built by the deploy), for the app's own
// "update available" check: it compares versionCode and appId with itself and
// then downloads /api/app/download. `release` is null when none is built.
export const GET = withAuth(async () => ok({ release: getAppRelease() }));
