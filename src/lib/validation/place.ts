import { z } from 'zod';

// Floors and rooms (Settings → Rooms & floors). Head of House and managers
// (settings:manage) change them; everyone reads them.

const placeName = z.string().trim().min(1, 'Give it a name.').max(60);

/** Create (no id) or rename a floor. */
export const saveFloorSchema = z.object({
  id: z.string().cuid().optional(),
  name: placeName,
});
export type SaveFloorInput = z.infer<typeof saveFloorSchema>;

/** Create (no id) or change a room: its name and which floor it's on. */
export const saveRoomSchema = z.object({
  id: z.string().cuid().optional(),
  name: placeName,
  floorId: z.string().cuid().nullable().optional(),
});
export type SaveRoomInput = z.infer<typeof saveRoomSchema>;

export const deletePlaceSchema = z.object({
  kind: z.enum(['floor', 'room']),
  id: z.string().cuid(),
});
export type DeletePlaceInput = z.infer<typeof deletePlaceSchema>;

/** The full new order of the floors, or of the rooms on one floor. */
export const reorderPlacesSchema = z.object({
  kind: z.enum(['floor', 'room']),
  ids: z.array(z.string().cuid()).min(1).max(200),
});
export type ReorderPlacesInput = z.infer<typeof reorderPlacesSchema>;
