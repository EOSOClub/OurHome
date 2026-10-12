import { describe, expect, it } from 'vitest';
import { USER_ROLES } from '@/lib/enums';
import {
  clampRadius,
  fitLiveCheck,
  fixAge,
  liveCheckChoices,
  liveCheckSettings,
  liveCheckState,
  locationConsent,
  MAP_PLACE_RADIUS,
  nextPresence,
  sharingMode,
  type LocationConsent,
} from '@/lib/location';
import { canChangeOwnSharing, canStartLiveCheck } from '@/lib/permissions';
import { saveMapPlaceSchema, updateLocationConsentSchema } from '@/lib/validation/location';

describe('location consent', () => {
  it('is off unless the member said yes', () => {
    expect(locationConsent({})).toEqual({ sharing: 'off', liveChecks: false });
    expect(locationConsent({ locationSharing: null, liveChecks: null })).toEqual({ sharing: 'off', liveChecks: false });
    expect(locationConsent({ locationSharing: 'on', liveChecks: true })).toEqual({ sharing: 'on', liveChecks: true });
  });

  it('treats an unknown stored value as off', () => {
    expect(sharingMode('always')).toBe('off');
    expect(sharingMode('required')).toBe('required');
  });

  it('never lets a member choose "required" for themselves', () => {
    expect(updateLocationConsentSchema.safeParse({ sharing: 'required' }).success).toBe(false);
    expect(updateLocationConsentSchema.safeParse({ sharing: 'on' }).success).toBe(true);
  });

  it('keeps required sharing from being turned off by the member', () => {
    expect(canChangeOwnSharing('required')).toBe(false);
    expect(canChangeOwnSharing('on')).toBe(true);
    expect(canChangeOwnSharing('off')).toBe(true);
  });
});

describe('canStartLiveCheck', () => {
  const yes: LocationConsent = { sharing: 'on', liveChecks: true };
  const target = (consent: LocationConsent) => ({ id: 'kid', consent });

  it('needs the target to share and to allow live checks', () => {
    const adult = { id: 'a', role: 'adult' };
    expect(canStartLiveCheck(adult, target(yes))).toBe(true);
    expect(canStartLiveCheck(adult, target({ sharing: 'on', liveChecks: false }))).toBe(false);
    expect(canStartLiveCheck(adult, target({ sharing: 'off', liveChecks: true }))).toBe(false);
  });

  it('gives no role authority without consent, not even the head', () => {
    expect(canStartLiveCheck({ id: 'h', role: 'head' }, target({ sharing: 'off', liveChecks: false }))).toBe(false);
  });

  it('is for adults and above only', () => {
    const allowed = USER_ROLES.filter((role) => canStartLiveCheck({ id: 'x', role }, target(yes)));
    expect(allowed).toEqual(['head', 'manager', 'adult']);
    expect(canStartLiveCheck({ id: 'x', role: 'nonsense' }, target(yes))).toBe(false);
  });

  it('is never on yourself', () => {
    expect(canStartLiveCheck({ id: 'kid', role: 'head' }, target(yes))).toBe(false);
  });
});

describe('nextPresence', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 9, 12, 12, min));
  const atHome = { state: 'place' as const, placeId: 'home', at: t(0) };

  it('records an arrival somewhere new', () => {
    expect(nextPresence(null, { placeId: 'home', transition: 'enter', at: t(5) })).toEqual({
      next: { state: 'place', placeId: 'home', at: t(5) },
      arrived: true,
    });
    expect(nextPresence(atHome, { placeId: 'store', transition: 'enter', at: t(5) })?.arrived).toBe(true);
  });

  it('ignores arriving where they already are, so a store never reminds twice', () => {
    expect(nextPresence(atHome, { placeId: 'home', transition: 'enter', at: t(30) })).toBeNull();
  });

  it('makes them away when they leave where they are', () => {
    expect(nextPresence(atHome, { placeId: 'home', transition: 'exit', at: t(9) })).toEqual({
      next: { state: 'away', placeId: null, at: t(9) },
      arrived: false,
    });
  });

  it('ignores leaving somewhere else, and leaving while already away', () => {
    expect(nextPresence(atHome, { placeId: 'store', transition: 'exit', at: t(9) })).toBeNull();
    expect(nextPresence({ state: 'away', placeId: null, at: t(0) }, { placeId: 'home', transition: 'exit', at: t(9) })).toBeNull();
  });

  it('takes a first report of leaving as away', () => {
    expect(nextPresence(null, { placeId: 'home', transition: 'exit', at: t(1) })?.next.state).toBe('away');
  });

  it('drops reports older than what is stored (a phone catching up after being offline)', () => {
    const atStore = { state: 'place' as const, placeId: 'store', at: t(20) };
    expect(nextPresence(atStore, { placeId: 'home', transition: 'exit', at: t(10) })).toBeNull();
    expect(nextPresence(atStore, { placeId: 'home', transition: 'enter', at: t(10) })).toBeNull();
  });
});

describe('map places', () => {
  const valid = { name: 'Home', kind: 'home', lat: 41.88, lng: -87.63, radiusM: 150 };

  it('clamps radii into the range phones can handle', () => {
    expect(clampRadius(20)).toBe(MAP_PLACE_RADIUS.min);
    expect(clampRadius(99_999)).toBe(MAP_PLACE_RADIUS.max);
    expect(clampRadius(333.4)).toBe(333);
    expect(clampRadius(Number.NaN)).toBe(MAP_PLACE_RADIUS.default);
  });

  it('accepts a place and defaults its lists to none', () => {
    const parsed = saveMapPlaceSchema.parse(valid);
    expect(parsed.shoppingListIds).toEqual([]);
  });

  it('refuses coordinates off the globe and radii out of range', () => {
    expect(saveMapPlaceSchema.safeParse({ ...valid, lat: 91 }).success).toBe(false);
    expect(saveMapPlaceSchema.safeParse({ ...valid, lng: -181 }).success).toBe(false);
    expect(saveMapPlaceSchema.safeParse({ ...valid, radiusM: 50 }).success).toBe(false);
    expect(saveMapPlaceSchema.safeParse({ ...valid, kind: 'school' }).success).toBe(false);
  });
});

describe('live checks', () => {
  it('uses the defaults until the head sets limits, and keeps limits in range', () => {
    expect(liveCheckSettings({})).toEqual({ maxMinutes: 30, minIntervalSec: 15 });
    expect(liveCheckSettings({ liveCheckMaxMinutes: 500, liveCheckMinIntervalSec: 1 })).toEqual({
      maxMinutes: 120,
      minIntervalSec: 15,
    });
  });

  it('offers only what the limits allow', () => {
    const choices = liveCheckChoices({ maxMinutes: 10, minIntervalSec: 60 });
    expect(choices.minutes).toEqual([5, 10]);
    expect(choices.intervals).toEqual([60, 120]);
    expect(choices.defaultMinutes).toBe(5);
    expect(choices.defaultIntervalSec).toBe(60);
  });

  it('brings a request inside the limits', () => {
    expect(fitLiveCheck({ maxMinutes: 30, minIntervalSec: 30 }, 120, 15)).toEqual({ minutes: 30, intervalSec: 30 });
    expect(fitLiveCheck({ maxMinutes: 30, minIntervalSec: 15 }, 5, 30)).toEqual({ minutes: 5, intervalSec: 30 });
  });

  it('labels how old a fix is', () => {
    const now = Date.parse('2026-10-12T15:10:00Z');
    expect(fixAge('2026-10-12T15:09:40Z', now)).toBe('updated 20s ago');
    expect(fixAge('2026-10-12T15:07:00Z', now)).toBe('updated 3 min ago');
    // A phone clock slightly ahead never reads as negative.
    expect(fixAge('2026-10-12T15:10:05Z', now)).toBe('updated 0s ago');
  });

  it('is waiting, then live, or not answering, then ended', () => {
    const startedAt = new Date('2026-10-12T15:00:00Z');
    const endsAt = new Date('2026-10-12T15:05:00Z');
    const at = (s: number) => new Date(startedAt.getTime() + s * 1000);
    const check = { startedAt, endsAt, endedAt: null, fixAt: null };
    expect(liveCheckState(check, at(20))).toBe('waiting');
    expect(liveCheckState(check, at(90))).toBe('no_answer');
    expect(liveCheckState({ ...check, fixAt: at(10) }, at(90))).toBe('live');
    expect(liveCheckState({ ...check, fixAt: at(10) }, at(300))).toBe('ended');
    expect(liveCheckState({ ...check, endedAt: at(30) }, at(40))).toBe('ended');
  });
});
