import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { ACTIVITY_AREAS } from '@/lib/activityAreas';

export const activityQuerySchema = z.object({
  area: z.enum(ACTIVITY_AREAS).optional(),
  userId: recordId.optional(),
  before: recordId.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
