import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { LIVE_CHECK_LIMITS, MAP_PLACE_KINDS, MAP_PLACE_RADIUS, SELF_SHARING } from '@/lib/location';

// Map places (Settings → Map places: Head of House and managers) and each
// member's own location sharing (Profile → Location).

/** Create (no id) or change a map place. */
export const saveMapPlaceSchema = z.object({
  id: recordId.optional(),
  name: z.string().trim().min(1, 'Give it a name.').max(60),
  kind: z.enum(MAP_PLACE_KINDS),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(MAP_PLACE_RADIUS.min).max(MAP_PLACE_RADIUS.max),
  // Stores only; ignored (stored empty) for other kinds.
  shoppingListIds: z.array(recordId).max(20).default([]),
});
export type SaveMapPlaceInput = z.infer<typeof saveMapPlaceSchema>;

export const deleteMapPlaceSchema = z.object({ id: recordId });
export type DeleteMapPlaceInput = z.infer<typeof deleteMapPlaceSchema>;

/** Address search for the pin picker. */
export const searchAddressSchema = z.object({ q: z.string().trim().min(3).max(200) });

/** The phone's battery as it reads it; sent with reports (optional for older apps). */
export const batterySchema = z.object({
  pct: z.number().int().min(0).max(100),
  charging: z.boolean(),
});

/**
 * The Android app's report: this member's phone arrived at (dwelled in) or
 * left a map place. The position and battery are the phone's at that moment.
 */
export const reportPresenceSchema = z.object({
  placeId: recordId,
  transition: z.enum(['enter', 'exit']),
  at: z.coerce.date(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  battery: batterySchema.optional(),
});
export type ReportPresenceInput = z.infer<typeof reportPresenceSchema>;

/** A member's own choices. "required" is never chosen by the member. */
export const updateLocationConsentSchema = z
  .object({
    sharing: z.enum(SELF_SHARING),
    liveChecks: z.boolean(),
  })
  .partial();
export type UpdateLocationConsentInput = z.infer<typeof updateLocationConsentSchema>;

// --- Live checks ---

/** Start one. Out-of-limit lengths and intervals are brought inside the limits. */
export const startLiveCheckSchema = z.object({
  targetId: recordId,
  minutes: z.number().int().min(1).max(LIVE_CHECK_LIMITS.maxMinutes.max),
  intervalSec: z.number().int().min(1).max(600),
});
export type StartLiveCheckInput = z.infer<typeof startLiveCheckSchema>;

export const liveCheckIdSchema = z.object({ id: recordId });

/** The checked person's phone sending where it is. */
export const liveCheckFixSchema = z.object({
  id: recordId,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
  at: z.coerce.date(),
  battery: batterySchema.optional(),
});
export type LiveCheckFixInput = z.infer<typeof liveCheckFixSchema>;

/** The phone's hourly battery reading, sent while its owner shares their location. */
export const reportBatterySchema = batterySchema.extend({ at: z.coerce.date() });
export type ReportBatteryInput = z.infer<typeof reportBatterySchema>;

/** The head's limits. */
export const liveCheckSettingsSchema = z.object({
  maxMinutes: z.number().int().min(LIVE_CHECK_LIMITS.maxMinutes.min).max(LIVE_CHECK_LIMITS.maxMinutes.max),
  minIntervalSec: z
    .number()
    .int()
    .min(LIVE_CHECK_LIMITS.minIntervalSec.min)
    .max(LIVE_CHECK_LIMITS.minIntervalSec.max),
});
export type LiveCheckSettingsInput = z.infer<typeof liveCheckSettingsSchema>;
