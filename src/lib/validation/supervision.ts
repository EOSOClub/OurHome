import { z } from 'zod';

/** Replace who supervises one child or teen. An empty list means nobody does. */
export const setSupervisorsSchema = z.object({
  supervisedId: z.string().min(1),
  supervisorIds: z.array(z.string().min(1)).max(50),
});
export type SetSupervisorsInput = z.infer<typeof setSupervisorsSchema>;

/** Ring a supervised child's phone. */
export const ringPhoneSchema = z.object({ targetId: z.string().min(1) });

/** Make a supervised child's location sharing required, or stop requiring it. */
export const setRequiredSharingSchema = z.object({
  supervisedId: z.string().min(1),
  required: z.boolean(),
});
export type SetRequiredSharingInput = z.infer<typeof setRequiredSharingSchema>;

/** Turn sharing a supervised child's app usage on or off. */
export const setUsageSharingSchema = z.object({
  supervisedId: z.string().min(1),
  share: z.boolean(),
});
export type SetUsageSharingInput = z.infer<typeof setUsageSharingSchema>;
