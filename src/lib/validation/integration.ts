import { z } from 'zod';

export const createIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

export const integrationIdSchema = z.object({ id: z.string().cuid() });
export type IntegrationIdInput = z.infer<typeof integrationIdSchema>;

// A household's own Paperless-ngx (Settings → Paperless, Head of House).
const httpUrl = z
  .string()
  .trim()
  .max(300)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'Use an http:// or https:// address.');

export const paperlessConnectionSchema = z.object({
  /** How this server reaches Paperless. */
  url: httpUrl,
  /** How people open it in a browser (links); blank = none. */
  publicUrl: z.union([httpUrl, z.literal('')]).optional().nullable(),
  /** API token of a read-only Paperless user; blank keeps the saved one. */
  token: z.string().trim().max(200).optional().nullable(),
});
export type PaperlessConnectionInput = z.infer<typeof paperlessConnectionSchema>;
