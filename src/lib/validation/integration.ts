import { z } from 'zod';

export const createIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

export const integrationIdSchema = z.object({ id: z.string().cuid() });
export type IntegrationIdInput = z.infer<typeof integrationIdSchema>;
