import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';

// Floors and rooms (Settings → Rooms & floors). Head of House and managers
// (settings:manage) change them; everyone reads them.

const placeName = z.string().trim().min(1, 'Give it a name.').max(60);

/** Create (no id) or rename a floor. */
export const saveFloorSchema = z.object({
  id: recordId.optional(),
  name: placeName,
});
export type SaveFloorInput = z.infer<typeof saveFloorSchema>;

/** Create (no id) or change a room: its name and which floor it's on. */
export const saveRoomSchema = z.object({
  id: recordId.optional(),
  name: placeName,
  floorId: recordId.nullable().optional(),
});
export type SaveRoomInput = z.infer<typeof saveRoomSchema>;

export const deletePlaceSchema = z.object({
  kind: z.enum(['floor', 'room']),
  id: recordId,
});
export type DeletePlaceInput = z.infer<typeof deletePlaceSchema>;

/** The full new order of the floors, or of the rooms on one floor. */
export const reorderPlacesSchema = z.object({
  kind: z.enum(['floor', 'room']),
  ids: z.array(recordId).min(1).max(200),
});
export type ReorderPlacesInput = z.infer<typeof reorderPlacesSchema>;
