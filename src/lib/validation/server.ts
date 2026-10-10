import { z } from 'zod';
import { FEATURES } from '@/lib/features';
import { nameSchema, passwordSchema, usernameSchema } from '@/lib/validation/user';

// Server admin (Server page): households on this server. Only the server
// admin may call these (serverAdminService.assertServerAdmin).

// A new household and its Head of House. The head gets the temporary password
// below and must choose their own at first sign-in.
export const createHouseholdSchema = z.object({
  householdName: nameSchema,
  head: z.object({
    name: nameSchema,
    username: usernameSchema,
    email: z.string().trim().email().max(160).optional(),
    password: passwordSchema,
  }),
});
export type CreateHouseholdInput = z.infer<typeof createHouseholdSchema>;

export const setHouseholdDisabledSchema = z.object({
  id: z.string().cuid(),
  disabled: z.boolean(),
});
export type SetHouseholdDisabledInput = z.infer<typeof setHouseholdDisabledSchema>;

// A new temporary password for the household's Head of House (locked out).
export const resetHeadPasswordSchema = z.object({
  id: z.string().cuid(),
  password: passwordSchema,
});
export type ResetHeadPasswordInput = z.infer<typeof resetHeadPasswordSchema>;

// Whether a household's Paperless may be on the server's private network.
export const setPaperlessNetworkSchema = z.object({
  id: z.string().cuid(),
  allowed: z.boolean(),
});

// The features a household has on (the rest are turned off).
export const setHouseholdFeaturesSchema = z.object({
  id: z.string().cuid(),
  enabled: z.array(z.enum(FEATURES)),
});
export type SetHouseholdFeaturesInput = z.infer<typeof setHouseholdFeaturesSchema>;

// Delete a household for good: its exact name, typed, confirms it.
export const deleteHouseholdSchema = z.object({
  id: z.string().cuid(),
  confirmName: z.string().max(200),
});

// Restore a household from its export file (Server page).
export const restoreHouseholdSchema = z.object({
  /** The export file's contents (checked by householdRestore.planRestore). */
  data: z.unknown(),
  /** Restore under another name; blank keeps the export's. */
  name: nameSchema.optional().or(z.literal('')),
  /** The restored Head of House's temporary password. */
  headPassword: passwordSchema,
});
