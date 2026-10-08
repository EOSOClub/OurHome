import { prisma } from '@/server/db/prisma';
import { getAppRelease, type AppRelease } from '@/server/services/appDownloadService';
import { pushSync } from '@/server/services/pushService';

// Tells everyone when the deploy has built a new Android app: one household-
// wide bell notification per version (it links to Profile, where the download
// is, on the site and in the app), plus a content-free push so phones check
// and post their own "update ready" alert. Runs with every reminder sweep, and
// the deploy script triggers a sweep right after a build, so it's prompt.

const KEY_PREFIX = 'app_release:';

/** The notification for a release; its dedupeKey makes it once per version. */
export function appReleaseNotification(release: AppRelease) {
  return {
    type: 'system',
    title: `Android app ${release.versionName} is ready`,
    body: 'Update from Profile → Android app, on the site or in the app. It installs over the old version, so you stay signed in.',
    subjectType: 'app_release',
    subjectId: String(release.versionCode),
    dedupeKey: `${KEY_PREFIX}${release.versionCode}`,
  };
}

/** Announces the app on offer to every household not told about it yet. Returns how many were told. */
export async function announceAppRelease(): Promise<number> {
  const release = getAppRelease();
  if (!release) return 0;
  const note = appReleaseNotification(release);
  const households = await prisma.household.findMany({ select: { id: true } });
  let told = 0;
  for (const { id } of households) {
    const known = await prisma.notification.findFirst({
      where: { householdId: id, dedupeKey: note.dedupeKey },
      select: { id: true },
    });
    if (known) continue;
    // An older version's notice is out of date once a newer one is out.
    await prisma.notification.deleteMany({ where: { householdId: id, dedupeKey: { startsWith: KEY_PREFIX } } });
    // readAt written explicitly: Mongo leaves an omitted field unset (see notificationService).
    await prisma.notification.create({ data: { householdId: id, ...note, readAt: null } });
    pushSync(id, { everyone: true }, 'app_update');
    told++;
  }
  if (told > 0) console.log(`[app] announced Android app ${release.versionName} to ${told} household(s)`);
  return told;
}
