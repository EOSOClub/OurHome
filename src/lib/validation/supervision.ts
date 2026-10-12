import { z } from 'zod';

/** Replace who supervises one child or teen. An empty list means nobody does. */
export const setSupervisorsSchema = z.object({
  supervisedId: z.string().min(1),
  supervisorIds: z.array(z.string().min(1)).max(50),
});
export type SetSupervisorsInput = z.infer<typeof setSupervisorsSchema>;

/** Ring a supervised child's phone. */
export const ringPhoneSchema = z.object({ targetId: z.string().min(1) });
