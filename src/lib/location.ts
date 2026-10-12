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

export function locationConsent(user: {
  locationSharing?: string | null;
  liveChecks?: boolean | null;
}): LocationConsent {
  return { sharing: sharingMode(user.locationSharing), liveChecks: user.liveChecks === true };
}
