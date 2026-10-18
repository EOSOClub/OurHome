import { z } from 'zod';
import { PHONE_RULES } from '@/lib/phoneHealth';

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

/** Require one protection on a supervised child's phone, or stop requiring it. */
export const setPhoneRuleSchema = z.object({
  supervisedId: z.string().min(1),
  rule: z.enum(PHONE_RULES),
  required: z.boolean(),
});
export type SetPhoneRuleInput = z.infer<typeof setPhoneRuleSchema>;

/** Ask a supervised child's phone to send its app usage now. */
export const refreshUsageSchema = z.object({ supervisedId: z.string().min(1) });

/** A supervised child's app usage history (GET query). */
export const usageHistoryQuerySchema = z.object({ supervisedId: z.string().min(1).max(64) });

/** An app's icon next to someone's app usage (GET query). */
export const usageIconQuerySchema = z.object({ app: z.string().trim().min(1).max(200) });
