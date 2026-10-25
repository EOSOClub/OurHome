// Schedules (parental controls; appScheduleService, supervisionService.saveSchedule):
// a named time window on a child's phone, like Bedtime 21:00 to 07:00 every
// day, when every app is closed apart from the ones their phone always keeps
// open and the ones the schedule still allows. Times are minutes after
// midnight on the phone's own clock; an end before the start runs past
// midnight, and the days (0 Sunday to 6 Saturday) are the days it starts on.
// The phone warns 5 minutes before the start, then covers apps like a blocked
// one. The Android app has the same rules (data/AppSchedules.kt).

/** Most schedules one child can have. */
export const MAX_SCHEDULES = 10;

/** Most apps a schedule still allows. */
export const MAX_ALLOWED = 30;

/** Short day names, Sunday first (a day's number is its place here). */
export const SCHEDULE_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [0, 6];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** What a new schedule can start from. */
export const SCHEDULE_PRESETS = [
  { name: 'Bedtime', days: EVERY_DAY, start: 21 * 60, end: 7 * 60 },
  { name: 'School', days: WEEKDAYS, start: 8 * 60, end: 15 * 60 },
  { name: 'Homework', days: WEEKDAYS, start: 16 * 60, end: 18 * 60 },
] as const;

/** "9:00 PM" for 1260 minutes after midnight. */
export function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "21:00", for a time input. */
export function clockValue(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Minutes after midnight from a time input's "21:00"; null when it isn't one. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". */
export function daysLabel(days: readonly number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const same = (other: number[]) => set.length === other.length && other.every((d) => set.includes(d));
  if (same(EVERY_DAY)) return 'Every day';
  if (same(WEEKDAYS)) return 'Weekdays';
  if (same(WEEKEND)) return 'Weekends';
  return set.map((d) => DAY_NAMES[d]).join(', ');
}

/** "9:00 PM to 7:00 AM", with "(next day)" when it runs past midnight. */
export function scheduleTimes(start: number, end: number): string {
  return `${formatClock(start)} to ${formatClock(end)}${end < start ? ' (next day)' : ''}`;
}

/** The card's line: "Bedtime 9:00 PM to 7:00 AM", or "3 schedules". */
export function schedulesSummary(schedules: { name: string; start: number; end: number }[]): string | null {
  if (schedules.length === 0) return null;
  if (schedules.length > 1) return `${schedules.length} schedules`;
  const [only] = schedules;
  return `${only.name} ${formatClock(only.start)} to ${formatClock(only.end)}`;
}
