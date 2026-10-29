import { z } from 'zod';
import { PHONE_RULES } from '@/lib/phoneHealth';
import { WEB_FILTERS } from '@/lib/webFilter';
import { LIMIT_MAX, LIMIT_MIN } from '@/lib/appLimits';
import { MAX_ALLOWED } from '@/lib/appSchedules';
import { CAP_MAX, CAP_MIN, RATE_MAX } from '@/lib/pointsTime';

/** Replaces the list of who supervises one child or teen. An empty list means nobody does. */
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

/** Choose the web filter on a supervised child's phone or turn it off. */
export const setWebFilterSchema = z.object({
  supervisedId: z.string().min(1),
  filter: z.enum(['off', ...WEB_FILTERS]),
});
export type SetWebFilterInput = z.infer<typeof setWebFilterSchema>;

/** Block an app on a supervised child's phone (app: its package name), or unblock it. */
export const setAppBlockedSchema = z.object({
  supervisedId: z.string().min(1),
  app: z.string().trim().min(1).max(200),
  blocked: z.boolean(),
});
export type SetAppBlockedInput = z.infer<typeof setAppBlockedSchema>;

/**
 * Set a daily limit on a supervised child's phone or remove it (minutes
 * null). app: its package name, or "*" for all apps together.
 */
export const setAppLimitSchema = z.object({
  supervisedId: z.string().min(1),
  app: z.string().trim().min(1).max(200),
  minutes: z.number().int().min(LIMIT_MIN).max(LIMIT_MAX).nullable(),
});
export type SetAppLimitInput = z.infer<typeof setAppLimitSchema>;

/**
 * Add a schedule to a supervised child's phone or change one (id). days: 0
 * (Sunday) to 6; start and end: minutes after midnight, end before start runs
 * past midnight. allowed: package names still open meanwhile.
 */
export const saveScheduleSchema = z
  .object({
    supervisedId: z.string().min(1),
    id: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1, 'Give it a name.').max(40, 'Keep the name under 40 characters.'),
    days: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day.').max(7),
    start: z.number().int().min(0).max(1439),
    end: z.number().int().min(0).max(1439),
    allowed: z.array(z.string().trim().min(1).max(200)).max(MAX_ALLOWED),
  })
  .refine((s) => s.start !== s.end, { message: 'The end has to be a different time from the start.', path: ['end'] });
export type SaveScheduleInput = z.infer<typeof saveScheduleSchema>;

/** Remove a schedule from a supervised child's phone. */
export const removeScheduleSchema = z.object({ supervisedId: z.string().min(1), id: z.string().min(1).max(64) });
export type RemoveScheduleInput = z.infer<typeof removeScheduleSchema>;

/** Let a supervised child spend points on screen time (minutesPerPoint null: stop). */
export const setPointsForTimeSchema = z.object({
  supervisedId: z.string().min(1),
  minutesPerPoint: z.number().int().min(1).max(RATE_MAX).nullable(),
  dailyCap: z.number().int().min(CAP_MIN).max(CAP_MAX),
});
export type SetPointsForTimeInput = z.infer<typeof setPointsForTimeSchema>;

/** Give a supervised child extra minutes on today's limits. */
export const giveExtraTimeSchema = z.object({
  supervisedId: z.string().min(1),
  minutes: z.number().int().min(5).max(CAP_MAX),
});
export type GiveExtraTimeInput = z.infer<typeof giveExtraTimeSchema>;

/** Ask a supervised child's phone to send its app usage now. */
export const refreshUsageSchema = z.object({ supervisedId: z.string().min(1) });

/** A supervised child's app usage history (GET query). */
export const usageHistoryQuerySchema = z.object({ supervisedId: z.string().min(1).max(64) });

/** An app's icon next to someone's app usage (GET query). */
export const usageIconQuerySchema = z.object({ app: z.string().trim().min(1).max(200) });
