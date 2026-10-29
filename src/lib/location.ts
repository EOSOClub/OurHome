// Location: map places, and each member's consent to share where they are.
// Pure, shared by the server (validation, services) and the client (Settings
// → Map places, Profile → Location). Who may do what with someone's location
// is decided in src/lib/permissions.ts (canStartLiveCheck, canChangeOwnSharing).

export const MAP_PLACE_KINDS = ['home', 'store', 'other'] as const;
export type MapPlaceKind = (typeof MAP_PLACE_KINDS)[number];

export const MAP_PLACE_KIND_LABELS: Record<MapPlaceKind, string> = {
  home: 'Home',
  store: 'Store',
  other: 'Other',
};

export function isMapPlaceKind(value: string): value is MapPlaceKind {
  return (MAP_PLACE_KINDS as readonly string[]).includes(value);
}

/**
 * Geofence radius in metres. Phones can't tell reliably whether they're inside
 * a circle much smaller than 150 m; past 2 km it stops meaning "at" a place.
 */
export const MAP_PLACE_RADIUS = { min: 150, max: 2000, default: 150 } as const;

/** Clamp a radius into the allowed range (rounded to whole metres). */
export function clampRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return MAP_PLACE_RADIUS.default;
  return Math.min(MAP_PLACE_RADIUS.max, Math.max(MAP_PLACE_RADIUS.min, Math.round(radiusM)));
}

/**
 * A member's location sharing. "required" is for parental controls: a
 * supervising adult turns it on and the member can't turn it off. Nothing sets
 * it yet; the value exists so that work needs no data migration.
 */
export const LOCATION_SHARING = ['off', 'on', 'required'] as const;
export type LocationSharing = (typeof LOCATION_SHARING)[number];

/** What a member can choose for themselves. */
export const SELF_SHARING = ['off', 'on'] as const satisfies readonly LocationSharing[];

/** The stored value as a mode; null or anything unknown is off. */
export function sharingMode(raw: string | null | undefined): LocationSharing {
  return (LOCATION_SHARING as readonly string[]).includes(raw ?? '') ? (raw as LocationSharing) : 'off';
}

export function isSharing(mode: LocationSharing): boolean {
  return mode !== 'off';
}

/** A member's location consent, as stored on their account. */
export interface LocationConsent {
  sharing: LocationSharing;
  /** Adults may start a short live location check on them. */
  liveChecks: boolean;
}

// --- Presence --------------------------------------------------------------------------
// The Android app reports arriving at (after a couple of minutes inside) and
// leaving each map place. Reports can arrive late or out of order (a phone
// offline for a while sends them when it reconnects), so each is judged
// against what's stored.

export type PresenceState = 'place' | 'away';

export interface PresenceSnapshot {
  state: PresenceState;
  /** The map place they're at; null when away. */
  placeId: string | null;
  /** When the phone noticed it. */
  at: Date;
}

export interface PresenceEvent {
  placeId: string;
  transition: 'enter' | 'exit';
  at: Date;
}

/**
 * What a report changes. null = nothing: it's older than what's stored, they
 * were already there, or they left a place they weren't recorded at (the
 * stored place is newer news). `arrived` is true when they just got to the
 * place, which is when store reminders go out.
 */
export function nextPresence(
  current: PresenceSnapshot | null,
  event: PresenceEvent,
): { next: PresenceSnapshot; arrived: boolean } | null {
  if (current && event.at.getTime() < current.at.getTime()) return null;
  const atThatPlace = current?.state === 'place' && current.placeId === event.placeId;
  if (event.transition === 'enter') {
    if (atThatPlace) return null;
    return { next: { state: 'place', placeId: event.placeId, at: event.at }, arrived: true };
  }
  // Leaving: away, unless the record already says they're somewhere else (or away).
  if (atThatPlace || !current) {
    return { next: { state: 'away', placeId: null, at: event.at }, arrived: false };
  }
  return null;
}

/**
 * A store reminder only makes sense while they're likely still there: a
 * report that reaches the server later than this (phone was offline) updates
 * presence but doesn't remind.
 */
export const REMINDER_FRESH_MS = 15 * 60_000;

/**
 * "You're home: 3 chores due" comes at most this often, so popping out for
 * ten minutes doesn't bring the same reminder again on the way back in.
 */
export const HOME_REMINDER_GAP_MS = 4 * 60 * 60_000;

/** Whether arriving home now may remind about chores again. */
export function homeReminderDue(lastRemindedAt: Date | null | undefined, now: Date): boolean {
  return !lastRemindedAt || now.getTime() - lastRemindedAt.getTime() >= HOME_REMINDER_GAP_MS;
}

// --- Battery ----------------------------------------------------------------------------
// The phone sends its battery with each presence report and live-check fix,
// and once an hour, while its owner shares their location. Shown next to
// them wherever presence is.

/** At or below this the level is shown as low. */
export const BATTERY_LOW_PCT = 20;

/** A reading older than this shows its age: the phone may be off or flat. */
export const BATTERY_STALE_MS = 2 * 60 * 60_000;

export interface BatteryReading {
  pct: number;
  charging: boolean;
  /** When the phone read it (ISO). */
  at: string;
}

/**
 * How a reading is shown: "85%", "85%, charging", "12%, 3 h ago". `low`
 * flags a flat-ish battery that isn't charging.
 */
export function batteryLabel(
  battery: BatteryReading,
  now: number = Date.now(),
): { text: string; low: boolean } {
  const ageMs = now - new Date(battery.at).getTime();
  const parts = [`${battery.pct}%`];
  if (ageMs >= BATTERY_STALE_MS) {
    const hours = Math.floor(ageMs / 3_600_000);
    parts.push(hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`);
  } else if (battery.charging) {
    parts.push('charging');
  }
  return { text: parts.join(', '), low: battery.pct <= BATTERY_LOW_PCT && !battery.charging };
}

// --- Live checks ------------------------------------------------------------------------
// An adult asks to see where someone is for a few minutes. Their phone shows
// that it's happening for the whole time and sends its position every interval;
// only the latest one is kept. The head limits how long a check may run and how
// often it may ask (Settings → Live location checks).

/** Choices offered when starting a check, before the household's limits. */
export const LIVE_CHECK_MINUTES = [5, 10, 15, 30, 60, 120] as const;
export const LIVE_CHECK_INTERVALS = [15, 30, 60, 120] as const;
export const LIVE_CHECK_DEFAULT = { minutes: 5, intervalSec: 30 } as const;

/** The head's limits: what they may be set to, and the default. */
export const LIVE_CHECK_LIMITS = {
  maxMinutes: { min: 5, max: 120, default: 30 },
  minIntervalSec: { min: 15, max: 120, default: 15 },
} as const;

export interface LiveCheckSettings {
  /** The longest a check may run. */
  maxMinutes: number;
  /** The shortest time between fixes. */
  minIntervalSec: number;
}

export function liveCheckSettings(household: {
  liveCheckMaxMinutes?: number | null;
  liveCheckMinIntervalSec?: number | null;
}): LiveCheckSettings {
  const { maxMinutes, minIntervalSec } = LIVE_CHECK_LIMITS;
  const clamp = (v: number | null | undefined, r: { min: number; max: number; default: number }) =>
    v == null || !Number.isFinite(v) ? r.default : Math.min(r.max, Math.max(r.min, Math.round(v)));
  return {
    maxMinutes: clamp(household.liveCheckMaxMinutes, maxMinutes),
    minIntervalSec: clamp(household.liveCheckMinIntervalSec, minIntervalSec),
  };
}

/** What someone starting a check may pick, and what's picked to begin with. */
export function liveCheckChoices(settings: LiveCheckSettings) {
  const minutes = LIVE_CHECK_MINUTES.filter((m) => m <= settings.maxMinutes);
  const intervals = LIVE_CHECK_INTERVALS.filter((s) => s >= settings.minIntervalSec);
  return {
    minutes,
    intervals,
    defaultMinutes: minutes.includes(LIVE_CHECK_DEFAULT.minutes) ? LIVE_CHECK_DEFAULT.minutes : minutes[0],
    defaultIntervalSec: intervals.includes(LIVE_CHECK_DEFAULT.intervalSec)
      ? LIVE_CHECK_DEFAULT.intervalSec
      : intervals[0],
  };
}

/** A requested length and interval brought inside the household's limits. */
export function fitLiveCheck(
  settings: LiveCheckSettings,
  minutes: number,
  intervalSec: number,
): { minutes: number; intervalSec: number } {
  return {
    minutes: Math.min(settings.maxMinutes, Math.max(1, Math.round(minutes))),
    intervalSec: Math.max(settings.minIntervalSec, Math.round(intervalSec)),
  };
}

/** No fix within this long of the start: the phone isn't answering. */
export const LIVE_CHECK_ANSWER_MS = 60_000;

/** How long a finished check stays in the checked person's log. */
export const LIVE_CHECK_LOG_DAYS = 30;

/**
 * waiting: just started, the phone hasn't sent a fix yet. live: fixes are
 * coming. no_answer: no fix a minute in (phone off, no signal, permission
 * gone). ended: stopped, or its time ran out.
 */
export type LiveCheckState = 'waiting' | 'live' | 'no_answer' | 'ended';

export function liveCheckState(
  check: { startedAt: Date; endsAt: Date; endedAt: Date | null; fixAt: Date | null },
  now: Date,
): LiveCheckState {
  if (check.endedAt || now.getTime() >= check.endsAt.getTime()) return 'ended';
  if (check.fixAt) return 'live';
  return now.getTime() - check.startedAt.getTime() > LIVE_CHECK_ANSWER_MS ? 'no_answer' : 'waiting';
}

/** A live fix's age for its label: "updated 20s ago", "updated 3 min ago". */
export function fixAge(at: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  return seconds < 90 ? `updated ${seconds}s ago` : `updated ${Math.round(seconds / 60)} min ago`;
}

export function locationConsent(user: {
  locationSharing?: string | null;
  liveChecks?: boolean | null;
}): LocationConsent {
  return { sharing: sharingMode(user.locationSharing), liveChecks: user.liveChecks === true };
}
