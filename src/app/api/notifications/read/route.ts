import { ok, parseBody, withAuth } from '@/server/api/http';
import { markRead } from '@/server/services/notificationService';
import { markReadSchema } from '@/lib/validation/notification';

export const POST = withAuth(async ({ user, req }) => {
  const input = await parseBody(req, markReadSchema);
  const result = await markRead(user.householdId!, user.id, input);
  return ok(result);
});
