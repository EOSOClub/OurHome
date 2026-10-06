import { z } from 'zod';
import { BUG_REPORT_SOURCES } from '@/lib/enums';

export const submitBugReportSchema = z.object({
  title: z.string().trim().min(3, 'Give the bug a short title.').max(150),
  description: z.string().trim().min(1, 'Describe what happened.').max(5000),
  source: z.enum(BUG_REPORT_SOURCES),
  // Where it happened: the web page path or the app screen.
  context: z.string().trim().max(300).optional().nullable(),
  appVersion: z.string().trim().max(40).optional().nullable(),
});

export type SubmitBugReportInput = z.infer<typeof submitBugReportSchema>;
