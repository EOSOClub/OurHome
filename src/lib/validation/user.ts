import { z } from 'zod';
import { USER_ROLES } from '@/lib/enums';
import {
  BIO_MAX,
  PRONOUNS_MAX,
  PROFILE_COLOR_KEYS,
  isBirthday,
  type ProfileColor,
} from '@/lib/profile';

// Mirrors the Better Auth username plugin defaults (3–30 chars). Letters,
// numbers, and . _ - so display names like "jane.d" work.
export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, and . _ - only.');

// Better Auth's emailAndPassword minimum is 8.
export const passwordSchema = z.string().min(8).max(128);

export const nameSchema = z.string().trim().min(1).max(80);

// Members may be created with a username only; email is optional and used for
// password recovery. When omitted the service synthesizes a local placeholder.
export const createMemberSchema = z.object({
  name: nameSchema,
  username: usernameSchema,
  email: z.string().trim().email().max(160).optional(),
  role: z.enum(USER_ROLES).default('member'),
  password: passwordSchema,
});
export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  id: z.string().cuid(),
  name: nameSchema.optional(),
  username: usernameSchema.optional(),
  email: z.string().trim().email().max(160).optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const setMemberRoleSchema = z.object({
  id: z.string().cuid(),
  role: z.enum(USER_ROLES),
});
export type SetMemberRoleInput = z.infer<typeof setMemberRoleSchema>;

export const resetMemberPasswordSchema = z.object({
  id: z.string().cuid(),
  password: passwordSchema,
});
export type ResetMemberPasswordInput = z.infer<
  typeof resetMemberPasswordSchema
>;

export const memberIdSchema = z.object({ id: z.string().cuid() });
export type MemberIdInput = z.infer<typeof memberIdSchema>;

// Rename the household (requires household:manage).
export const renameHouseholdSchema = z.object({ name: nameSchema });
export type RenameHouseholdInput = z.infer<typeof renameHouseholdSchema>;

// Allow or refuse sign-in over plain HTTP (requires household:manage).
export const accessSettingsSchema = z.object({ allowHttp: z.boolean() });
export type AccessSettingsInput = z.infer<typeof accessSettingsSchema>;

/** Exactly one emoji (one grapheme with a pictograph or a flag in it). */
function isSingleEmoji(v: string): boolean {
  if (v.length > 32) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(v);
}

// Optional profile text: blank clears it (stored as null).
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

// Self-service profile edits (the signed-in user editing their own account).
// The "about me" fields: omitted = unchanged, null or "" = cleared.
export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    username: usernameSchema.optional(),
    email: z.string().trim().email().max(160).optional(),
    bio: optionalText(BIO_MAX),
    pronouns: optionalText(PRONOUNS_MAX),
    avatarEmoji: optionalText(32).refine((v) => v == null || isSingleEmoji(v), {
      message: 'Pick a single emoji.',
    }),
    profileColor: z.enum(PROFILE_COLOR_KEYS as [ProfileColor, ...ProfileColor[]]).nullable().optional(),
    birthday: optionalText(5).refine((v) => v == null || isBirthday(v), {
      message: 'Birthday must be a real MM-DD day.',
    }),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update.',
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
