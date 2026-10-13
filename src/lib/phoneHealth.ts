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
 * quiet: hasn't checked in for [PHONE_QUIET_MS]. location_off: their sharing
 * is required, but the phone no longer lets OurHome use location all the time.
 * usage_off: their app usage is shared, but the phone no longer allows Usage
 * access (so nothing can be measured).
 */
export const PHONE_PROBLEMS = ['quiet', 'location_off', 'usage_off'] as const;
export type PhoneProblem = (typeof PHONE_PROBLEMS)[number];

export interface PhoneSnapshot {
  lastSeenAt: Date;
  locationAlways: boolean;
  /** null: an app from before usage reporting, which can't say. */
  usageAccess?: boolean | null;
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

/**
 * What's wrong with a child's phone right now. Nothing for a phone that never
 * checked in (no app yet, or an older app). A quiet phone's last report is
 * stale, so only "quiet" is said then. Location matters only while their
 * sharing is required and the household uses Location; Usage access only
 * while their app usage is shared, and only from apps that report it.
 */
export function phoneProblems(phone: PhoneSnapshot | null, expect: PhoneExpectations, now: Date): PhoneProblem[] {
  if (!phone) return [];
  if (now.getTime() - phone.lastSeenAt.getTime() >= PHONE_QUIET_MS) return ['quiet'];
  const out: PhoneProblem[] = [];
  if (expect.locationOn !== false && expect.sharing === 'required' && !phone.locationAlways) out.push('location_off');
  if (expect.usageShared && phone.usageAccess === false) out.push('usage_off');
  return out;
}

/** The alert's text for [name]'s phone. */
export function phoneAlertText(problem: PhoneProblem, name: string): { title: string; body: string } {
  if (problem === 'quiet') {
    return {
      title: `${name}’s phone hasn’t checked in`,
      body: `Nothing from ${name}’s phone for over ${PHONE_QUIET_MS / 3_600_000} hours. It may be off, flat or out of signal, or OurHome may have been signed out or uninstalled there.`,
    };
  }
  if (problem === 'usage_off') {
    return {
      title: `${name}’s app usage can’t be measured`,
      body: `${name}’s app usage is shared, but their phone no longer gives OurHome Usage access, so their screen time can’t be seen.`,
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
  location_off: 'Location turned off on their phone',
  usage_off: 'Usage access turned off on their phone',
};
