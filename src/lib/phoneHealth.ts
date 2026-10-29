// Phone check-ins (parental controls): whether a supervised child's phone is
// still doing its part. Pure, shared by the server (the sweep's alerts) and
// the client (the Map's "People you look after" card). See phoneStatusService.

import type { LocationSharing } from '@/lib/location';
import { webFilterOn, type WebFilter } from '@/lib/webFilter';

/**
 * A phone that hasn't checked in for this long counts as quiet: off, flat,
 * out of signal for hours, signed out, or uninstalled. Phones check in about
 * hourly, but Android can hold background work back for a few hours while a
 * phone sits idle, so this leaves room before anyone is alerted.
 */
export const PHONE_QUIET_MS = 8 * 60 * 60_000;

/**
 * A phone that holds a Stay connected stream with battery Unrestricted is
 * missed after this long instead: its connection drops the moment it goes,
 * and it reconnects within a few minutes after a network change, a reboot, or
 * an app update (its longest wait between tries is 5 minutes).
 */
export const PHONE_QUICK_QUIET_MS = 20 * 60_000;

/** At or below this (and not charging) at its last word, a quiet phone has probably run flat. */
export const PHONE_FLAT_PCT = 5;

/** At or below this (and not charging), the adults who look after them are told it's running low. */
export const PHONE_LOW_PCT = 15;

/** A status read this long before the phone's last word still says how it was then. */
const STATUS_FRESH_MS = 45 * 60_000;
/** A shutdown said this close to the phone's last word was what ended it. */
const SHUTDOWN_NEAR_MS = 5 * 60_000;

/**
 * Why a phone went quiet, the best guess first:
 * - app_removed: Firebase says OurHome is no longer on that installation
 *   (uninstalled, or its data cleared).
 * - switched_off: the phone said Android was switching it off.
 * - battery_flat: its battery was nearly empty, not charging.
 * - no_signal: it had no network or barely any mobile signal.
 * - quiet: nothing to tell why.
 *
 * Problems while it's not quiet: notifications_off: Android's notifications
 * are off for OurHome there, so rings can't show Stop and the child misses
 * the household's alerts. location_off: their sharing is required, but
 * the phone no longer lets OurHome use location all the time. usage_off: their
 * app usage is shared, but the phone no longer allows Usage access (so nothing
 * can be measured). web_filter_off: a supervising adult chose a web filter,
 * but the phone's Private DNS isn't set to it (lib/webFilter.ts), so websites
 * aren't filtered there. battery_low: its battery was at [PHONE_LOW_PCT] or below
 * and not charging at its last word, so it may soon go flat; gone once it
 * charges or climbs back over. battery_restricted: Android's battery optimization still
 * applies to OurHome there, which can delay rings, live checks, and alerts, or
 * stop the app in the background. close_guard_off: "Keep Our Home running" is
 * off in Android's Accessibility settings, so the child can close OurHome
 * (Android's Stop or Force stop). uninstall_guard_off: OurHome isn't a device
 * admin there, so it can be uninstalled without the parent's PIN.
 * emergency_unlock_*: the child started the emergency unlock period (it can't
 * be canceled; the parent chose its length, 1, 5, or 10 hours, when setting
 * the PIN), one alert per milestone; while it runs, the guards being off is
 * part of it and isn't alerted separately. battery_restricted,
 * close_guard_off, and uninstall_guard_off only while a supervising adult
 * requires that protection ([PHONE_RULES]).
 */
export const PHONE_PROBLEMS = [
  'quiet',
  'app_removed',
  'switched_off',
  'battery_flat',
  'no_signal',
  'notifications_off',
  'location_off',
  'usage_off',
  'web_filter_off',
  'battery_low',
  'battery_restricted',
  'close_guard_off',
  'uninstall_guard_off',
  'emergency_unlock_started',
  'emergency_unlock_2h',
  'emergency_unlock_1h',
  'emergency_unlock_30m_left',
  'emergency_unlock_4h_left',
  'emergency_unlock_7h_left',
  'emergency_unlock_unlocked',
] as const;
export type PhoneProblem = (typeof PHONE_PROBLEMS)[number];

/**
 * The milestones of an emergency unlock period, as the phone sends them (its
 * CloseGuard.EmergencyDuration). "2h_elapsed" is only in the 5-hour period,
 * "3h_elapsed" and "6h_elapsed" are only in the 10-hour one.
 */
export const EMERGENCY_UNLOCK_STAGES = [
  'started',
  '30m_left',
  '2h_elapsed',
  '3h_elapsed',
  '6h_elapsed',
  '1h_left',
  'unlocked',
] as const;
export type EmergencyUnlockStage = (typeof EMERGENCY_UNLOCK_STAGES)[number];

const EMERGENCY_PROBLEMS: Record<EmergencyUnlockStage, PhoneProblem> = {
  started: 'emergency_unlock_started',
  '30m_left': 'emergency_unlock_30m_left',
  '2h_elapsed': 'emergency_unlock_2h',
  '3h_elapsed': 'emergency_unlock_7h_left',
  '6h_elapsed': 'emergency_unlock_4h_left',
  '1h_left': 'emergency_unlock_1h',
  unlocked: 'emergency_unlock_unlocked',
};

/** How long a running emergency unlock period has left at each countdown milestone. */
const EMERGENCY_LEFT: Partial<Record<PhoneProblem, string>> = {
  emergency_unlock_30m_left: '30 minutes',
  emergency_unlock_1h: '1 hour',
  emergency_unlock_2h: '3 hours',
  emergency_unlock_4h_left: '4 hours',
  emergency_unlock_7h_left: '7 hours',
};

/** The problems that mean the phone went quiet (only one is ever given). */
export const SILENT_PROBLEMS: ReadonlySet<PhoneProblem> = new Set([
  'quiet',
  'app_removed',
  'switched_off',
  'battery_flat',
  'no_signal',
]);

/**
 * The protections a supervising adult chooses for each child's phone, on
 * People you look after (User.requireKeepRunning and the rest; never chosen
 * means required). keepRunning: "Keep Our Home running" (the close guard,
 * an Accessibility service), so OurHome can't be closed. preventUninstall:
 * OurHome as a device admin with the parent's PIN, so it can't be removed.
 * batteryUnrestricted: battery optimization turned off for OurHome, so rings and
 * alerts aren't held back.
 */
export const PHONE_RULES = ['keepRunning', 'preventUninstall', 'batteryUnrestricted'] as const;
export type PhoneRule = (typeof PHONE_RULES)[number];
export type PhoneRules = Record<PhoneRule, boolean>;

export const PHONE_RULE_LABELS: Record<PhoneRule, string> = {
  keepRunning: 'Keep Our Home running',
  preventUninstall: 'Prevent uninstall',
  batteryUnrestricted: 'Unrestricted battery',
};

/** The User column that holds each rule. */
export const PHONE_RULE_COLUMNS = {
  keepRunning: 'requireKeepRunning',
  preventUninstall: 'requirePreventUninstall',
  batteryUnrestricted: 'requireBatteryUnrestricted',
} as const satisfies Record<PhoneRule, string>;

export type PhoneRuleColumns = { [K in (typeof PHONE_RULE_COLUMNS)[PhoneRule]]: boolean | null };

/** A member's rules as stored: only an adult's explicit "off" (false) turns one off. */
export function phoneRules(user: Partial<PhoneRuleColumns>): PhoneRules {
  return {
    keepRunning: user.requireKeepRunning !== false,
    preventUninstall: user.requirePreventUninstall !== false,
    batteryUnrestricted: user.requireBatteryUnrestricted !== false,
  };
}

/**
 * The steps of Set up this phone, in the app's order (its PhoneSetupSteps.kt):
 * Keep Our Home running last, because once it's on, App info, Device admin, and
 * Accessibility can't be opened there.
 */
export const PHONE_SETUP_STEPS = [
  'notifications',
  'location',
  'batteryUnrestricted',
  'usageAccess',
  'webFilter',
  'preventUninstall',
  'keepRunning',
] as const;
export type PhoneSetupStep = (typeof PHONE_SETUP_STEPS)[number];
export type PhoneSetupRequired = Record<PhoneSetupStep, boolean>;

/** Each step as the app names it. */
export const PHONE_SETUP_STEP_LABELS: Record<PhoneSetupStep, string> = {
  notifications: 'Allow notifications',
  location: 'Allow location all the time',
  batteryUnrestricted: 'Allow unrestricted battery',
  usageAccess: 'Allow usage access',
  webFilter: 'Turn on the web filter',
  preventUninstall: 'Prevent uninstall',
  keepRunning: 'Keep Our Home running',
};

/**
 * Which steps a supervised child's phone must do: notifications always (the
 * household's alerts and the ring's Stop need them), location all the time
 * while their sharing is required and the household uses Location, Usage
 * access while their app usage is shared, the web filter while one is chosen,
 * and the protections their supervisors require.
 */
export function setupRequired(expect: PhoneExpectations): PhoneSetupRequired {
  return {
    notifications: true,
    location: expect.locationOn !== false && expect.sharing === 'required',
    usageAccess: expect.usageShared === true,
    webFilter: expect.webFilter != null,
    ...(expect.rules ?? phoneRules({})),
  };
}

/** What a phone last said about each step; null: an app too old to say. */
export type PhoneSetupChecks = Record<PhoneSetupStep, boolean | null>;

/**
 * The phone's own word on each step, from its last check-in. The web filter
 * is done while its Private DNS is [webFilter]'s hostname (null: none chosen).
 */
export function setupChecks(phone: PhoneSnapshot, webFilter: WebFilter | null = null): PhoneSetupChecks {
  return {
    notifications: phone.notifications ?? null,
    location: phone.locationAlways,
    batteryUnrestricted: phone.batteryUnrestricted ?? null,
    usageAccess: phone.usageAccess ?? null,
    webFilter: webFilter ? webFilterOn(webFilter, phone.privateDns) : null,
    preventUninstall: phone.uninstallGuard ?? null,
    keepRunning: phone.closeGuard ?? null,
  };
}

/**
 * The required steps in order, each done or not as the phone last said;
 * done is null before any phone checked in, or when its app can't say.
 */
export function setupProgress(
  required: PhoneSetupRequired,
  checks: PhoneSetupChecks | null,
): { step: PhoneSetupStep; done: boolean | null }[] {
  return PHONE_SETUP_STEPS.filter((step) => required[step]).map((step) => ({
    step,
    done: checks ? checks[step] : null,
  }));
}

export interface PhoneSnapshot {
  lastSeenAt: Date;
  locationAlways: boolean;
  /** Notifications allowed for OurHome; undefined: not known here. */
  notifications?: boolean;
  /** null: an app from before usage reporting, which can't say. */
  usageAccess?: boolean | null;
  /** The phone's Private DNS: a hostname, or "off" (lib/webFilter.ts); null: an app from before web filtering. */
  privateDns?: string | null;
  /** null: an app from before the delivery check, which can't say. */
  batteryUnrestricted?: boolean | null;
  /** null: an app from before the close guard, which can't say. */
  closeGuard?: boolean | null;
  /** null: an app from before the guard against uninstalling, which can't say. */
  uninstallGuard?: boolean | null;
  /** The last milestone of the emergency unlock period; null while none is running. */
  emergencyUnlockStage?: string | null;
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
  /** The protections their supervisors require; omitted: all of them. */
  rules?: PhoneRules;
  /** The web filter a supervising adult chose; null or omitted: none. */
  webFilter?: WebFilter | null;
}

/** Whichever phone checked in last, or null if none ever did. */
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
 * A phone holding its stream is never quiet. If Firebase has called its token
 * dead since its last word, OurHome is gone, and that shows at once. Otherwise, a phone that
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

/** Its battery was low and not charging, read with its last word (an older reading may have changed since). */
function isLow(phone: PhoneSnapshot): boolean {
  if (phone.batteryPct == null || phone.batteryPct > PHONE_LOW_PCT || phone.batteryCharging === true) return false;
  return phone.statusAt != null && lastWordAt(phone).getTime() - phone.statusAt.getTime() <= STATUS_FRESH_MS;
}

/**
 * What's wrong with a child's phone right now. Nothing for a phone that never
 * checked in (no app yet, or an older app). A quiet phone's last report is
 * stale, so only why it's quiet is said then. Location matters only while
 * their sharing is required and the household uses Location; Usage access
 * only while their app usage is shared, and only from apps that report it.
 * The web filter while one is chosen, once the phone has said what its
 * Private DNS is. A low battery always, from its latest reading. Battery saving, the close
 * guard, and the guard against uninstalling only while their
 * supervisors require them ([PHONE_RULES]). The milestones of an emergency unlock
 * period always: the guard is there, and the child is taking it off.
 */
export function phoneProblems(phone: PhoneSnapshot | null, expect: PhoneExpectations, now: Date): PhoneProblem[] {
  if (!phone) return [];
  const silence = phoneSilence(phone, now);
  if (silence) return [silence];
  const rules = expect.rules ?? phoneRules({});
  const out: PhoneProblem[] = [];
  if (phone.notifications === false) out.push('notifications_off');
  if (expect.locationOn !== false && expect.sharing === 'required' && !phone.locationAlways) out.push('location_off');
  if (expect.usageShared && phone.usageAccess === false) out.push('usage_off');
  if (expect.webFilter && webFilterOn(expect.webFilter, phone.privateDns) === false) out.push('web_filter_off');
  if (isLow(phone)) out.push('battery_low');
  if (rules.batteryUnrestricted && phone.batteryUnrestricted === false) out.push('battery_restricted');
  const emergency = EMERGENCY_PROBLEMS[phone.emergencyUnlockStage as EmergencyUnlockStage] ?? null;
  if (emergency) {
    out.push(emergency);
  } else {
    if (rules.keepRunning && phone.closeGuard === false) out.push('close_guard_off');
    if (rules.preventUninstall && phone.uninstallGuard === false) out.push('uninstall_guard_off');
  }
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
  if (problem === 'notifications_off') {
    return {
      title: `Notifications are off for OurHome on ${name}’s phone`,
      body: `${name}’s phone doesn’t let OurHome show notifications, so they miss the household’s alerts and can’t stop a ring from the notification. On their phone, open OurHome and follow Set up this phone.`,
    };
  }
  if (problem === 'usage_off') {
    return {
      title: `${name}’s app usage can’t be measured`,
      body: `${name}’s app usage is shared, but their phone no longer gives OurHome Usage access, so their screen time can’t be seen.`,
    };
  }
  if (problem === 'web_filter_off') {
    return {
      title: `${name}’s phone isn’t filtering websites`,
      body: `The web filter you chose for ${name} is off on their phone (its Private DNS was changed), so websites aren’t filtered there. On their phone, open OurHome and follow Set up this phone.`,
    };
  }
  if (problem === 'battery_low') {
    return {
      title: `${name}’s phone battery is low`,
      body: `${name}’s phone is at ${PHONE_LOW_PCT}% or less and not charging. Remind them to charge it, so they can still be reached.`,
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
  if (problem === 'uninstall_guard_off') {
    return {
      title: `OurHome can be uninstalled on ${name}’s phone`,
      body: `The uninstall guard is off on ${name}’s phone, so OurHome can be removed there without your PIN. On their phone, open Profile in OurHome to turn it back on.`,
    };
  }
  if (problem === 'emergency_unlock_started') {
    return {
      title: `${name} started an emergency unlock`,
      body: `${name} started the emergency unlock on their phone. It can’t be cancelled: when it ends, OurHome can be uninstalled there without your PIN.`,
    };
  }
  const left = EMERGENCY_LEFT[problem];
  if (left) {
    return {
      title: `Emergency unlock on ${name}’s phone: ${left} left`,
      body: `The emergency unlock on ${name}’s phone ends in about ${left === '1 hour' ? 'an hour' : left}. Then OurHome can be uninstalled there without your PIN.`,
    };
  }
  if (problem === 'emergency_unlock_unlocked') {
    return {
      title: `Emergency unlock finished on ${name}’s phone`,
      body: `The emergency unlock on ${name}’s phone has finished, so OurHome can now be uninstalled there without your PIN.`,
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
  notifications_off: 'Notifications turned off on their phone',
  location_off: 'Location turned off on their phone',
  usage_off: 'Usage access turned off on their phone',
  web_filter_off: 'Web filter turned off on their phone',
  battery_low: 'Their phone battery is low',
  battery_restricted: 'Battery saving can delay OurHome on their phone',
  close_guard_off: 'OurHome can be closed on their phone',
  uninstall_guard_off: 'OurHome can be uninstalled on their phone',
  emergency_unlock_started: 'Emergency unlock started on their phone',
  emergency_unlock_2h: 'Emergency unlock on their phone: 3 hours left',
  emergency_unlock_1h: 'Emergency unlock on their phone: 1 hour left',
  emergency_unlock_30m_left: 'Emergency unlock on their phone: 30 minutes left',
  emergency_unlock_4h_left: 'Emergency unlock on their phone: 4 hours left',
  emergency_unlock_7h_left: 'Emergency unlock on their phone: 7 hours left',
  emergency_unlock_unlocked: 'Emergency unlock finished on their phone',
};
