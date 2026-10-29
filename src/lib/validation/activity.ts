import { z } from 'zod';
import { ACTIVITY_AREAS } from '@/lib/activityAreas';

export const activityQuerySchema = z.object({
  area: z.enum(ACTIVITY_AREAS).optional(),
  userId: z.cuid().optional(),
  before: z.cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
