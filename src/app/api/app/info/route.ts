import { ok, withAuth } from '@/server/api/http';
import { appBuilding, getAppRelease } from '@/server/services/appDownloadService';

// The Android app this server offers (built by the deployment), for the app's own
// "update available" check: it compares versionCode and appId with itself and
// then downloads /api/app/download. `release` is null when none is built.
// `building`: a new one is being built now; the app holds "What's new" until
// it runs the new build.
export const GET = withAuth(async () => ok({ release: getAppRelease(), building: appBuilding() }));
