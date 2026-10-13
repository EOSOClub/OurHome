import { z } from 'zod';

/** The Android app checking in (hourly): which install, and what it may do. */
export const phoneCheckInSchema = z.object({
  installId: z.string().trim().min(8).max(100),
  appVersion: z.string().trim().max(40).optional(),
  deviceName: z.string().trim().max(80).optional(),
  locationAlways: z.boolean(),
  notifications: z.boolean(),
  /** Android's Usage access granted; left out by apps from before usage reporting. */
  usageAccess: z.boolean().optional(),
});
export type PhoneCheckInInput = z.infer<typeof phoneCheckInSchema>;

/** A phone's app usage: today and yesterday, as it measured them. */
export const reportUsageSchema = z.object({
  days: z
    .array(
      z.object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A day is YYYY-MM-DD.'),
        totalMinutes: z.number().int().min(0).max(1440),
        apps: z
          .array(
            z.object({
              app: z.string().trim().min(1).max(200),
              label: z.string().trim().max(100),
              minutes: z.number().int().min(0).max(1440),
            }),
          )
          .max(100),
      }),
    )
    .min(1)
    .max(3),
});
export type ReportUsageInput = z.infer<typeof reportUsageSchema>;

/** App icons the server asked for after a usage report: PNG, base64. */
export const reportUsageIconsSchema = z.object({
  icons: z
    .array(
      z.object({
        app: z.string().trim().min(1).max(200),
        // 32 KB as base64 is under 44,000 characters; the service checks the bytes.
        png: z.string().min(1).max(44_000),
      }),
    )
    .min(1)
    .max(20),
});
export type ReportUsageIconsInput = z.infer<typeof reportUsageIconsSchema>;
