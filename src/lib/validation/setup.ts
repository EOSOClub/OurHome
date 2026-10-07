import { z } from 'zod';
import { nameSchema, passwordSchema, usernameSchema } from '@/lib/validation/user';

// First-run setup: the household and its Head of House. Email is optional, as
// for every member; without one the account gets a local placeholder address.
export const setupSchema = z.object({
  householdName: nameSchema,
  username: usernameSchema,
  email: z.string().trim().email().max(160).optional(),
  password: passwordSchema,
});
export type SetupInput = z.infer<typeof setupSchema>;
