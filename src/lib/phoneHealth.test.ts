import { describe, expect, it } from 'vitest';
import {
  PHONE_QUICK_QUIET_MS,
  PHONE_QUIET_MS,
  SILENT_PROBLEMS,
  freshestPhone,
  phoneAlertText,
  phoneProblems,
  phoneSilence,
} from '@/lib/phoneHealth';

const now = new Date('2026-10-12T18:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe('why a phone went quiet', () => {
  // A phone holding Stay connected with Unrestricted battery: its stream closed 25 minutes ago.
  const watched = {
    lastSeenAt: hoursAgo(1),
    locationAlways: true,
    stayConnected: true,
    batteryUnrestricted: true,
    streamAt: minsAgo(25),
  };

  it('misses a phone that holds a connection after 20 minutes, any other after 8 hours', () => {
    expect(PHONE_QUICK_QUIET_MS).toBe(20 * 60_000);
    expect(phoneSilence(watched, now)).toBe('quiet');
    expect(phoneSilence({ ...watched, streamAt: minsAgo(15) }, now)).toBeNull();
    // Still connected: never quiet.
    expect(phoneSilence({ ...watched, connected: true }, now)).toBeNull();
    // Battery saving can hold its connection back for hours, so it isn't trusted to be quick.
    expect(phoneSilence({ ...watched, batteryUnrestricted: false }, now)).toBeNull();
    expect(phoneSilence({ ...watched, stayConnected: false }, now)).toBeNull();
    expect(phoneSilence({ lastSeenAt: hoursAgo(7), locationAlways: true }, now)).toBeNull();
    expect(phoneSilence({ lastSeenAt: hoursAgo(8), locationAlways: true }, now)).toBe('quiet');
  });

  it('says OurHome was removed once Firebase calls its token dead, without waiting', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true, streamAt: minsAgo(12), pushGoneAt: minsAgo(4) };
    expect(phoneSilence(phone, now)).toBe('app_removed');
    // Only a few minutes quiet: a rotated token is re-registered by then.
    expect(phoneSilence({ ...phone, streamAt: minsAgo(6) }, now)).toBeNull();
    // A dead token from before the phone's last word says nothing.
    expect(phoneSilence({ ...phone, pushGoneAt: minsAgo(30), streamAt: minsAgo(12) }, now)).toBeNull();
  });

  it('tells a switched-off phone, a flat battery and no signal apart by its last word', () => {
    expect(phoneSilence({ ...watched, shutdownAt: minsAgo(26) }, now)).toBe('switched_off');
    expect(phoneSilence({ ...watched, shutdownAt: minsAgo(26), batteryPct: 2, batteryCharging: false }, now)).toBe(
      'battery_flat',
    );
    const status = { statusAt: minsAgo(40) };
    expect(phoneSilence({ ...watched, ...status, batteryPct: 4, batteryCharging: false }, now)).toBe('battery_flat');
    // Charging: it didn't run flat.
    expect(phoneSilence({ ...watched, ...status, batteryPct: 4, batteryCharging: true }, now)).toBe('quiet');
    expect(phoneSilence({ ...watched, ...status, network: 'none' }, now)).toBe('no_signal');
    expect(phoneSilence({ ...watched, ...status, network: 'cellular', signalLevel: 1 }, now)).toBe('no_signal');
    expect(phoneSilence({ ...watched, ...status, network: 'cellular', signalLevel: 3 }, now)).toBe('quiet');
    expect(phoneSilence({ ...watched, ...status, network: 'wifi', signalLevel: 0 }, now)).toBe('quiet');
    // A status read long before its last word is too old to say.
    expect(phoneSilence({ ...watched, statusAt: hoursAgo(2), network: 'none' }, now)).toBe('quiet');
  });

  it('gives each reason its own alert and line, and only one at a time', () => {
    for (const p of SILENT_PROBLEMS) expect(phoneAlertText(p, 'Mia').title).toMatch(/Mia/);
    expect(phoneAlertText('app_removed', 'Mia').title).toBe('OurHome may have been removed from Mia’s phone');
    expect(phoneProblems({ ...watched, closeGuard: false, network: 'none', statusAt: minsAgo(40) }, { sharing: 'on' }, now)).toEqual([
      'no_signal',
    ]);
  });
});

describe('phone problems', () => {
  it('says nothing about a phone that never checked in', () => {
    expect(phoneProblems(null, { sharing: 'required' }, now)).toEqual([]);
  });

  it('calls a phone quiet after 8 hours, and then says only that', () => {
    expect(PHONE_QUIET_MS).toBe(8 * 3_600_000);
    expect(phoneProblems({ lastSeenAt: hoursAgo(7.9), locationAlways: true }, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneProblems({ lastSeenAt: hoursAgo(8), locationAlways: false }, { sharing: 'required' }, now)).toEqual(['quiet']);
  });

  it('flags location off only while sharing is required and Location is on', () => {
    const off = { lastSeenAt: hoursAgo(1), locationAlways: false };
    expect(phoneProblems(off, { sharing: 'required' }, now)).toEqual(['location_off']);
    expect(phoneProblems(off, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneProblems(off, { sharing: 'required', locationOn: false }, now)).toEqual([]);
    expect(phoneProblems({ ...off, locationAlways: true }, { sharing: 'required' }, now)).toEqual([]);
  });

  it('flags Usage access off only while app usage is shared, and only when the app says', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true };
    expect(phoneProblems({ ...phone, usageAccess: false }, { sharing: 'on', usageShared: true }, now)).toEqual(['usage_off']);
    expect(phoneProblems({ ...phone, usageAccess: false }, { sharing: 'on' }, now)).toEqual([]);
    // An app from before usage reporting can't say: no alert.
    expect(phoneProblems({ ...phone, usageAccess: null }, { sharing: 'on', usageShared: true }, now)).toEqual([]);
    expect(
      phoneProblems({ ...phone, locationAlways: false, usageAccess: false }, { sharing: 'required', usageShared: true }, now),
    ).toEqual(['location_off', 'usage_off']);
  });

  it('flags battery saving still applying, only when the app says, and not on a quiet phone', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true };
    expect(phoneProblems({ ...phone, batteryUnrestricted: false }, { sharing: 'on' }, now)).toEqual(['battery_restricted']);
    expect(phoneProblems({ ...phone, batteryUnrestricted: true }, { sharing: 'on' }, now)).toEqual([]);
    // An app from before the delivery check can't say: no alert.
    expect(phoneProblems({ ...phone, batteryUnrestricted: null }, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneProblems({ ...phone, lastSeenAt: hoursAgo(9), batteryUnrestricted: false }, { sharing: 'on' }, now)).toEqual([
      'quiet',
    ]);
    expect(phoneAlertText('battery_restricted', 'Mia').body).toMatch(/allow Unrestricted battery/);
  });

  it('flags a phone where OurHome can be closed, only when the app says', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true };
    expect(phoneProblems({ ...phone, closeGuard: false }, { sharing: 'on' }, now)).toEqual(['close_guard_off']);
    expect(phoneProblems({ ...phone, closeGuard: true }, { sharing: 'on' }, now)).toEqual([]);
    // An app from before the close guard can't say: no alert.
    expect(phoneProblems({ ...phone, closeGuard: null }, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneAlertText('close_guard_off', 'Mia').body).toMatch(/Keep Our Home running/);
  });

  it('flags a phone where OurHome can be uninstalled, only when the app says', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true };
    expect(phoneProblems({ ...phone, uninstallGuard: false }, { sharing: 'on' }, now)).toEqual(['uninstall_guard_off']);
    expect(phoneProblems({ ...phone, uninstallGuard: true }, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneProblems({ ...phone, uninstallGuard: null }, { sharing: 'on' }, now)).toEqual([]);
    expect(phoneAlertText('uninstall_guard_off', 'Mia').title).toBe('OurHome can be uninstalled on Mia’s phone');
  });

  it('says only the emergency unlock milestone while one runs, not the guards it turned off', () => {
    const phone = { lastSeenAt: hoursAgo(1), locationAlways: true, closeGuard: false, uninstallGuard: false };
    const at = (stage: string) => phoneProblems({ ...phone, emergencyUnlockStage: stage }, { sharing: 'on' }, now);
    expect(at('started')).toEqual(['emergency_unlock_started']);
    expect(at('2h_elapsed')).toEqual(['emergency_unlock_2h']);
    expect(at('1h_left')).toEqual(['emergency_unlock_1h']);
    expect(at('unlocked')).toEqual(['emergency_unlock_unlocked']);
    // None running (or a milestone this server doesn't know): the guards are alerted as usual.
    expect(phoneProblems({ ...phone, emergencyUnlockStage: null }, { sharing: 'on' }, now)).toEqual([
      'close_guard_off',
      'uninstall_guard_off',
    ]);
    expect(at('later')).toEqual(['close_guard_off', 'uninstall_guard_off']);
    // A quiet phone says only why it's quiet.
    expect(phoneProblems({ ...phone, lastSeenAt: hoursAgo(9), emergencyUnlockStage: 'started' }, { sharing: 'on' }, now)).toEqual([
      'quiet',
    ]);
    expect(phoneAlertText('emergency_unlock_started', 'Mia').body).toMatch(/can’t be cancelled/);
    expect(phoneAlertText('emergency_unlock_2h', 'Mia').title).toBe('Emergency unlock on Mia’s phone: 3 hours left');
  });

  it('judges a member by their freshest phone', () => {
    const old = { id: 'a', lastSeenAt: hoursAgo(20) };
    const fresh = { id: 'b', lastSeenAt: hoursAgo(1) };
    expect(freshestPhone([old, fresh])?.id).toBe('b');
    expect(freshestPhone([])).toBeNull();
  });

  it('names the child in the alert', () => {
    expect(phoneAlertText('quiet', 'Mia').title).toBe('Mia’s phone hasn’t checked in');
    expect(phoneAlertText('location_off', 'Mia').body).toMatch(/Mia’s sharing is required/);
  });
});
