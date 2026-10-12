import { z } from 'zod';
import { MAP_PLACE_KINDS, MAP_PLACE_RADIUS, SELF_SHARING } from '@/lib/location';

// Map places (Settings → Map places: Head of House and managers) and each
// member's own location sharing (Profile → Location).

/** Create (no id) or change a map place. */
export const saveMapPlaceSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Give it a name.').max(60),
  kind: z.enum(MAP_PLACE_KINDS),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(MAP_PLACE_RADIUS.min).max(MAP_PLACE_RADIUS.max),
  // Stores only; ignored (stored empty) for other kinds.
  shoppingListIds: z.array(z.string().cuid()).max(20).default([]),
});
export type SaveMapPlaceInput = z.infer<typeof saveMapPlaceSchema>;

export const deleteMapPlaceSchema = z.object({ id: z.string().cuid() });
export type DeleteMapPlaceInput = z.infer<typeof deleteMapPlaceSchema>;

/** Address search for the pin picker. */
export const searchAddressSchema = z.object({ q: z.string().trim().min(3).max(200) });

/** A member's own choices. "required" is never chosen by the member. */
export const updateLocationConsentSchema = z
  .object({
    sharing: z.enum(SELF_SHARING),
    liveChecks: z.boolean(),
  })
  .partial();
export type UpdateLocationConsentInput = z.infer<typeof updateLocationConsentSchema>;
