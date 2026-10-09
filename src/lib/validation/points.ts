import { z } from 'zod';
import { isValidTimeZone } from '@/lib/taskCycles';

export const POINTS_PERIODS = ['day', 'week', 'month', 'year'] as const;

// "YYYY-MM-DD" in the household's time zone; checked again by parseLocalDate.
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const pointsSummaryQuerySchema = z.object({
  period: z.enum(POINTS_PERIODS).default('week'),
  date: localDateSchema.optional(),
});

export const pointsAwardsQuerySchema = z.object({
  userId: z.string().cuid().optional(),
  period: z.enum(POINTS_PERIODS).optional(),
  date: localDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const voidAwardSchema = z.object({
  awardId: z.string().cuid(),
  reason: z.string().trim().min(1).max(200),
});

export const pointsSettingsSchema = z.object({
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone, 'Unknown time zone.')
    .optional(),
  weekStartsOn: z.number().int().min(0).max(6).optional(),
  minutesPerPoint: z.number().min(0.1).max(1440).optional(),
});

export type PointsSettingsInput = z.infer<typeof pointsSettingsSchema>;
