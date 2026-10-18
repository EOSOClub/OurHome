import { z } from 'zod';
import { EMERGENCY_UNLOCK_STAGES } from '@/lib/phoneHealth';
import { RING_REPORTS } from '@/lib/ring';

/**
 * How the phone is doing, so a phone that goes quiet can be told apart (flat,
 * out of signal, switched off, or OurHome removed). network: "wifi" |
 * "cellular" | "other" | "none"; signal: mobile signal 0 (none) to 4 (great).
 */
export const phoneStatusSchema = z.object({
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  network: z.enum(['wifi', 'cellular', 'other', 'none']).optional(),
  signal: z.number().int().min(0).max(4).optional(),
});
export type PhoneStatusInput = z.infer<typeof phoneStatusSchema>;

/** The Android app checking in (hourly): which install, and what it may do. */
export const phoneCheckInSchema = z.object({
  installId: z.string().trim().min(8).max(100),
  appVersion: z.string().trim().max(40).optional(),
  deviceName: z.string().trim().max(80).optional(),
  locationAlways: z.boolean(),
  notifications: z.boolean(),
  /** Android's Usage access granted; left out by apps from before usage reporting. */
  usageAccess: z.boolean().optional(),
  // Left out by apps from before the delivery check:
  /** When the last instant alert reached the phone (its clock, epoch ms), and which way. */
  lastPushAtMs: z.number().int().positive().optional(),
  lastPushVia: z.enum(['firebase', 'connection']).optional(),
  /** Battery "Unrestricted": Android's battery optimization doesn't hold the app back. */
  batteryUnrestricted: z.boolean().optional(),
  /** Android's app standby bucket (10 active ... 45 restricted), for diagnosing late alerts. */
  standbyBucket: z.number().int().min(0).max(100).optional(),
  /** Stay connected is turned on in the app. */
  stayConnected: z.boolean().optional(),
  /** "Keep Our Home running" is on in Android's Accessibility settings (left out by older apps). */
  closeGuard: z.boolean().optional(),
  /** OurHome is a device admin there, so uninstalling needs the parent's PIN (left out by older apps). */
  uninstallGuard: z.boolean().optional(),
  /**
   * An emergency unlock milestone due now; sent once each. One this server
   * doesn't know (a newer app) is dropped rather than refusing the check-in:
   * a refused check-in leaves the phone looking quiet to its supervisors.
   */
  emergencyUnlockStage: z.enum(EMERGENCY_UNLOCK_STAGES).optional().catch(undefined),
  /** When a running emergency unlock finishes (the phone's clock); left out when none is running. */
  emergencyUnlockReadyAtMs: z.number().int().positive().optional(),
  /** Sent only while an adult looks after the member (phoneStatusSchema). */
  status: phoneStatusSchema.optional(),
  /** Android is switching the phone off: this is its last word until it's back. */
  shuttingDown: z.boolean().optional(),
});
export type PhoneCheckInInput = z.infer<typeof phoneCheckInSchema>;

/**
 * A phone opening its Stay connected stream: which install (the check-in's
 * id), and its status as query fields (only while an adult looks after them).
 */
export const phoneStreamQuerySchema = z.object({
  installId: z.string().trim().min(8).max(100),
  battery: z.coerce.number().int().min(0).max(100).optional(),
  charging: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  network: z.enum(['wifi', 'cellular', 'other', 'none']).optional(),
  signal: z.coerce.number().int().min(0).max(4).optional(),
});

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

/** Apps the phone found since its last look (package name and the name it shows). */
export const reportNewAppsSchema = z.object({
  apps: z
    .array(
      z.object({
        app: z.string().trim().min(1).max(200),
        label: z.string().trim().max(100),
      }),
    )
    .min(1)
    .max(50),
});
export type ReportNewAppsInput = z.infer<typeof reportNewAppsSchema>;

/** What the phone did with a ring (ringId: from the ring push). */
export const reportRingSchema = z.object({
  ringId: z.string().trim().min(1).max(100),
  state: z.enum(RING_REPORTS),
});
export type ReportRingInput = z.infer<typeof reportRingSchema>;
