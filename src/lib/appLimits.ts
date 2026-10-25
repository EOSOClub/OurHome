import { formatMinutes } from '@/lib/appUsage';

// Daily limits (parental controls; appLimitService, supervisionService.setAppLimit):
// a supervising adult gives one app, or all apps together, so many minutes a
// day on a child's phone. The phone counts today's minutes itself (Android's
// Usage access), warns the child 5 minutes before, then covers the app like a
// blocked one until midnight on the phone. The Android app has the same rules
// (data/AppLimits.kt).

/** The app value meaning all apps together (a package name can't contain "*"). */
export const ALL_APPS = '*';

/** What the list calls all apps together. */
export const ALL_APPS_LABEL = 'All apps';

/** The limits offered, in minutes (the server takes any whole number from LIMIT_MIN to LIMIT_MAX). */
export const LIMIT_CHOICES = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360] as const;
export const LIMIT_MIN = 5;
export const LIMIT_MAX = 1440;

/** "1 h a day". */
export function limitLabel(minutes: number): string {
  return `${formatMinutes(minutes)} a day`;
}

/** LIMIT_CHOICES, plus [current] in its place when it isn't one (set from elsewhere). */
export function limitOptions(current?: number | null): number[] {
  const out: number[] = [...LIMIT_CHOICES];
  if (current != null && !out.includes(current)) out.push(current);
  return out.sort((a, b) => a - b);
}

/** The bell alert to a supervisor when [name]'s phone used up a limit ([label] null: all apps). */
export function limitReachedText(name: string, label: string | null, minutes: number): { title: string; body: string } {
  if (label === null) {
    return {
      title: `${name} used up their app time for today`,
      body: `${name} reached their ${limitLabel(minutes)} limit. Their apps are closed until tomorrow; calls and messages still work.`,
    };
  }
  return {
    title: `${name} used up their ${label} time for today`,
    body: `${name} reached the ${limitLabel(minutes)} limit for ${label}. It's closed on their phone until tomorrow.`,
  };
}

/** The card's line: "3 h a day in apps", "YouTube limited", "3 h a day in apps, 2 app limits". */
export function limitsSummary(totalMinutes: number | null, apps: { label: string }[]): string | null {
  const parts: string[] = [];
  if (totalMinutes !== null) parts.push(`${limitLabel(totalMinutes)} in apps`);
  if (apps.length === 1) parts.push(`${apps[0].label} limited`);
  else if (apps.length > 1) parts.push(`${apps.length} app limits`);
  return parts.length ? parts.join(', ') : null;
}
