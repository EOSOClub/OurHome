// App usage (parental controls): screen time per app, measured on a child's
// phone while a supervising adult has turned sharing it on. Pure, shared by
// the server (appUsageService) and the client ("People you look after", the
// child's Profile).

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
  return addDays(newest, -(USAGE_KEEP_DAYS - 1));
}

/** [day] ("YYYY-MM-DD") moved by [n] days. */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The bell alert for apps new on a child's phone: "Riley installed Roblox",
 * "... Roblox and YouTube", or "... 3 new apps" with every name in the body.
 */
export function newAppText(name: string, labels: string[]): { title: string; body: string } {
  const where = 'On their phone. Their app usage is on People you look after.';
  if (labels.length === 1) return { title: `${name} installed ${labels[0]}`, body: where };
  if (labels.length === 2) return { title: `${name} installed ${labels[0]} and ${labels[1]}`, body: where };
  const list = `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
  return { title: `${name} installed ${labels.length} new apps`, body: `${list}. ${where}` };
}

/** Days in the usage chart: a week, ending today. */
export const USAGE_CHART_DAYS = 7;

/** One bar of the chart. minutes: null when their phone sent nothing for that day. */
export interface ChartDay {
  day: string;
  minutes: number | null;
}

/**
 * The chart's days, oldest first: the week ending at the viewer's [today], or
 * at the newest reported day when that's later (a phone a time zone ahead).
 */
export function chartDays(days: { day: string; totalMinutes: number }[], today: string): ChartDay[] {
  const byDay = new Map(days.map((d) => [d.day, d.totalMinutes]));
  const newest = days.reduce((max, d) => (d.day > max ? d.day : max), today);
  return Array.from({ length: USAGE_CHART_DAYS }, (_, i) => {
    const day = addDays(newest, i - (USAGE_CHART_DAYS - 1));
    return { day, minutes: byDay.get(day) ?? null };
  });
}

/** The average day over the chart days their phone reported, in whole minutes; null when none. */
export function averageMinutes(chart: ChartDay[]): number | null {
  const reported = chart.filter((c) => c.minutes !== null);
  if (reported.length === 0) return null;
  return Math.round(reported.reduce((sum, c) => sum + c.minutes!, 0) / reported.length);
}

/** A chart bar's short day name: "Mon". */
export function weekdayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}
