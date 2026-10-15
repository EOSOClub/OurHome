import { z } from 'zod';

// An FCM registration token. Opaque and long (~150-200 chars today); the bound
// only stops abuse, it isn't a format check.
export const pushDeviceSchema = z.object({
  token: z.string().trim().min(20).max(4096),
  /** The app's install id (the check-in's); left out by older apps and on sign-out. */
  installId: z.string().trim().min(8).max(100).optional(),
});

export type PushDeviceInput = z.infer<typeof pushDeviceSchema>;
