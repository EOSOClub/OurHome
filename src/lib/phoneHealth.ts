// Phone check-ins (parental controls): whether a supervised child's phone is
// still doing its part. Pure, shared by the server (the sweep's alerts) and
// the client (the Map's "People you look after" card). See phoneStatusService.

import type { LocationSharing } from '@/lib/location';

/**
 * A phone that hasn't checked in for this long counts as quiet: off, flat,
 * out of signal for hours, signed out or uninstalled. Phones check in about
 * hourly, but Android can hold background work back for a few hours while a
 * phone sits idle, so this leaves room before anyone is alerted.
 */
export const PHONE_QUIET_MS = 8 * 60 * 60_000;

/**
 * A phone that holds a Stay connected stream with battery Unrestricted is
 * missed after this long instead: its connection drops the moment it goes,
 * and it reconnects within a few minutes after a network change, a reboot or
 * an app update (its longest wait between tries is 5 minutes).
 */
export const PHONE_QUICK_QUIET_MS = 20 * 60_000;

/** At or below this (and not charging) at its last word, a quiet phone has probably run flat. */
export const PHONE_FLAT_PCT = 5;

/** A status read this long before the phone's last word still says how it was then. */
const STATUS_FRESH_MS = 45 * 60_000;
/** A shutdown said this close to the phone's last word was what ended it. */
const SHUTDOWN_NEAR_MS = 5 * 60_000;

/**
 * Why a phone went quiet, best guess first:
 * - app_removed: Firebase says OurHome is no longer on that install
 *   (uninstalled, or its data cleared).
 * - switched_off: the phone said Android was switching it off.
 * - battery_flat: its battery was nearly empty, not charging.
 * - no_signal: it had no network, or barely any mobile signal.
 * - quiet: nothing to tell why.
 *
 * Problems while it's not quiet: location_off: their sharing is required, but
 * the phone no longer lets OurHome use location all the time. usage_off: their
 * app usage is shared, but the phone no longer allows Usage access (so nothing
 * can be measured). battery_restricted: Android's battery optimization still
 * applies to OurHome there, which can delay rings, live checks and alerts, or
 * stop the app in the background. close_guard_off: "Keep Our Home running" is
 * off in Android's Accessibility settings, so the child can close OurHome
 * (Android's Stop or Force stop).
 */
export const PHONE_PROBLEMS = [
  'quiet',
  'app_removed',
  'switched_off',
  'battery_flat',
  'no_signal',
  'location_off',
  'usage_off',
  'battery_restricted',
  'close_guard_off',
] as const;
export type PhoneProblem = (typeof PHONE_PROBLEMS)[number];

/** The problems that mean the phone went quiet (only one is ever given). */
export const SILENT_PROBLEMS: ReadonlySet<PhoneProblem> = new Set([
  'quiet',
  'app_removed',
  'switched_off',
  'battery_flat',
  'no_signal',
]);

export interface PhoneSnapshot {
  lastSeenAt: Date;
  locationAlways: boolean;
  /** null: an app from before usage reporting, which can't say. */
  usageAccess?: boolean | null;
  /** null: an app from before the delivery check, which can't say. */
  batteryUnrestricted?: boolean | null;
  /** null: an app from before the close guard, which can't say. */
  closeGuard?: boolean | null;
  /** Stay connected is on in the app. */
  stayConnected?: boolean | null;
  /** Holding its stream to this server right now (in memory, not stored). */
  connected?: boolean;
  /** When its stream last opened or closed. */
  streamAt?: Date | null;
  /** Its last status (null fields: not sent). */
  batteryPct?: number | null;
  batteryCharging?: boolean | null;
  network?: string | null;
  signalLevel?: number | null;
  statusAt?: Date | null;
  shutdownAt?: Date | null;
  pushGoneAt?: Date | null;
}

/** What the child's settings ask of their phone. */
export interface PhoneExpectations {
  sharing: LocationSharing;
  /** A supervising adult turned app usage sharing on. */
  usageShared?: boolean;
  /** The household uses Location (server admin). */
  locationOn?: boolean;
}

/** The phone that checked in most recently, or null if none ever did. */
export function freshestPhone<T extends { lastSeenAt: Date }>(phones: T[]): T | null {
  return phones.reduce<T | null>((best, p) => (!best || p.lastSeenAt > best.lastSeenAt ? p : best), null);
}

/** The last time the phone was heard from: a check-in, or its stream opening or closing. */
export function lastWordAt(phone: PhoneSnapshot): Date {
  const stream = phone.streamAt;
  return stream && stream > phone.lastSeenAt ? stream : phone.lastSeenAt;
}

/**
 * Whether the phone is quiet, and the likeliest reason; null while it isn't.
 * A phone holding its stream is never quiet. Firebase calling its token dead
 * since its last word says OurHome is gone, at once. Otherwise a phone that
 * keeps a stream with battery Unrestricted is missed after
 * [PHONE_QUICK_QUIET_MS], any other after [PHONE_QUIET_MS]; then its last
 * word says why: a shutdown, a nearly flat battery, or no signal.
 */
export function phoneSilence(phone: PhoneSnapshot, now: Date): PhoneProblem | null {
  if (phone.connected) return null;
  const last = lastWordAt(phone).getTime();
  const quietMs = now.getTime() - last;
  // A token can die by Firebase rotating it too; the app registers the new
  // one at once, so a few minutes' silence first rules that out.
  if (phone.pushGoneAt && phone.pushGoneAt.getTime() >= last && quietMs >= 10 * 60_000) return 'app_removed';
  const watched = phone.stayConnected === true && phone.batteryUnrestricted === true && phone.streamAt != null;
  if (quietMs < (watched ? PHONE_QUICK_QUIET_MS : PHONE_QUIET_MS)) return null;
  if (phone.shutdownAt && last - phone.shutdownAt.getTime() <= SHUTDOWN_NEAR_MS) {
    return isFlat(phone) ? 'battery_flat' : 'switched_off';
  }
  if (phone.statusAt && last - phone.statusAt.getTime() <= STATUS_FRESH_MS) {
    if (isFlat(phone)) return 'battery_flat';
    if (phone.network === 'none' || (phone.network === 'cellular' && (phone.signalLevel ?? 4) <= 1)) return 'no_signal';
  }
  return 'quiet';
}

function isFlat(phone: PhoneSnapshot): boolean {
  return phone.batteryPct != null && phone.batteryPct <= PHONE_FLAT_PCT && phone.batteryCharging !== true;
}

/**
 * What's wrong with a child's phone right now. Nothing for a phone that never
 * checked in (no app yet, or an older app). A quiet phone's last report is
 * stale, so only why it's quiet is said then. Location matters only while
 * their sharing is required and the household uses Location; Usage access
 * only while their app usage is shared, and only from apps that report it.
 */
export function phoneProblems(phone: PhoneSnapshot | null, expect: PhoneExpectations, now: Date): PhoneProblem[] {
  if (!phone) return [];
  const silence = phoneSilence(phone, now);
  if (silence) return [silence];
  const out: PhoneProblem[] = [];
  if (expect.locationOn !== false && expect.sharing === 'required' && !phone.locationAlways) out.push('location_off');
  if (expect.usageShared && phone.usageAccess === false) out.push('usage_off');
  if (phone.batteryUnrestricted === false) out.push('battery_restricted');
  if (phone.closeGuard === false) out.push('close_guard_off');
  return out;
}

/** The alert's text for [name]'s phone. */
export function phoneAlertText(problem: PhoneProblem, name: string): { title: string; body: string } {
  if (problem === 'quiet') {
    return {
      title: `${name}’s phone hasn’t checked in`,
      body: `${name}’s phone has stopped checking in. It may be off, flat or out of signal, or OurHome may have been closed, signed out or uninstalled there.`,
    };
  }
  if (problem === 'app_removed') {
    return {
      title: `OurHome may have been removed from ${name}’s phone`,
      body: `${name}’s phone stopped answering, and Firebase says OurHome is no longer installed there (or its data was cleared). Check their phone.`,
    };
  }
  if (problem === 'switched_off') {
    return {
      title: `${name}’s phone was switched off`,
      body: `${name}’s phone told OurHome it was switching off, and it hasn’t come back since.`,
    };
  }
  if (problem === 'battery_flat') {
    return {
      title: `${name}’s phone probably ran out of battery`,
      body: `${name}’s phone went quiet with its battery nearly empty and not charging. It checks in again once it’s charged and on.`,
    };
  }
  if (problem === 'no_signal') {
    return {
      title: `${name}’s phone may be out of signal`,
      body: `${name}’s phone went quiet with little or no signal. It checks in again once it’s back in coverage.`,
    };
  }
  if (problem === 'usage_off') {
    return {
      title: `${name}’s app usage can’t be measured`,
      body: `${name}’s app usage is shared, but their phone no longer gives OurHome Usage access, so their screen time can’t be seen.`,
    };
  }
  if (problem === 'battery_restricted') {
    return {
      title: `Battery saving may hold OurHome back on ${name}’s phone`,
      body: `Battery saving on ${name}’s phone can delay rings, live checks and alerts, or stop OurHome in the background. On their phone, open Profile in OurHome and allow Unrestricted battery.`,
    };
  }
  if (problem === 'close_guard_off') {
    return {
      title: `${name} can close OurHome on their phone`,
      body: `“Keep Our Home running” is off on ${name}’s phone, so Android’s Stop button can close OurHome there. On their phone, open Profile in OurHome and follow the steps under Keep Our Home running.`,
    };
  }
  return {
    title: `${name}’s location is off`,
    body: `${name}’s sharing is required, but their phone no longer lets OurHome use location all the time, so the household can’t see where they are.`,
  };
}

/** A short line for the card: "Phone problem" or null when all is well. */
export const PHONE_PROBLEM_LABELS: Record<PhoneProblem, string> = {
  quiet: 'Phone hasn’t checked in',
  app_removed: 'OurHome may have been removed from their phone',
  switched_off: 'Their phone is switched off',
  battery_flat: 'Their phone probably ran out of battery',
  no_signal: 'Their phone may be out of signal',
  location_off: 'Location turned off on their phone',
  usage_off: 'Usage access turned off on their phone',
  battery_restricted: 'Battery saving can delay OurHome on their phone',
  close_guard_off: 'OurHome can be closed on their phone',
};
