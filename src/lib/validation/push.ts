import { z } from 'zod';

// An FCM registration token. Opaque and long (~150-200 chars today); the bound
// only stops abuse, it isn't a format check.
export const pushDeviceSchema = z.object({
  token: z.string().trim().min(20).max(4096),
});

export type PushDeviceInput = z.infer<typeof pushDeviceSchema>;
