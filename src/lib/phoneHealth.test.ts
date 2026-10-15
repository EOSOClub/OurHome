import { describe, expect, it } from 'vitest';
import { PHONE_QUIET_MS, freshestPhone, phoneAlertText, phoneProblems } from '@/lib/phoneHealth';

const now = new Date('2026-10-12T18:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

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
