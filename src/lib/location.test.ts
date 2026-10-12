import { describe, expect, it } from 'vitest';
import { USER_ROLES } from '@/lib/enums';
import { clampRadius, locationConsent, MAP_PLACE_RADIUS, sharingMode, type LocationConsent } from '@/lib/location';
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
