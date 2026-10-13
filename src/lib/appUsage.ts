// App usage (parental controls): screen time per app, measured on a child's
// phone while a supervising adult has turned sharing it on. Pure, shared by
// the server (appUsageService) and the client (the Map's "People you look
// after" card, the child's Profile).

/** Days of usage kept per member; older ones are deleted as new ones arrive. */
export const USAGE_KEEP_DAYS = 14;

/** Apps kept per day, most used first. */
export const USAGE_TOP_APPS = 20;

/** Apps shown on the card. */
export const USAGE_CARD_APPS = 3;

/** Largest app icon a phone may send (a 96 px PNG is a few KB). */
export const USAGE_ICON_MAX_BYTES = 32 * 1024;

/** A supervisor opening "People you look after" asks the child's phone for fresh usage at most this often. */
export const USAGE_REFRESH_COOLDOWN_MS = 2 * 60_000;

/** Where the page loads an app's icon from (GET, supervisors only). */
export function usageIconUrl(app: string): string {
  return `/api/supervision/usage/icon?app=${encodeURIComponent(app)}`;
}

/** Whether [bytes] start like a PNG file. */
export function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > sig.length && sig.every((b, i) => bytes[i] === b);
}

export interface AppMinutes {
  /** The app's package name, e.g. "com.google.android.youtube". */
  app: string;
  /** Its name as the phone shows it, e.g. "YouTube". */
  label: string;
  minutes: number;
}

/** "2 h 5 min", "45 min", "under a minute". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return 'under a minute';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/**
 * How the card names a reported [day] ("YYYY-MM-DD"), given the viewer's
 * [today]: "Today", "Yesterday", or a short date like "Oct 10".
 */
export function usageDayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  if (day === d.toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A day's apps as stored: merged by app, most used first, capped, minutes whole. */
export function tidyApps(apps: AppMinutes[]): AppMinutes[] {
  const byApp = new Map<string, AppMinutes>();
  for (const a of apps) {
    const minutes = Math.max(0, Math.round(a.minutes));
    if (minutes === 0) continue;
    const prev = byApp.get(a.app);
    byApp.set(a.app, { app: a.app, label: a.label || prev?.label || a.app, minutes: (prev?.minutes ?? 0) + minutes });
  }
  return [...byApp.values()].sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label)).slice(0, USAGE_TOP_APPS);
}

/** The oldest day ("YYYY-MM-DD") still kept when [newest] is the latest one. */
export function oldestKeptDay(newest: string): string {
  const d = new Date(`${newest}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (USAGE_KEEP_DAYS - 1));
  return d.toISOString().slice(0, 10);
}
