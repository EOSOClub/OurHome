import { ok, parseQuery, withAuth } from '@/server/api/http';
import { listTaskCompletions } from '@/server/services/taskService';
import { taskCompletionsQuerySchema } from '@/lib/validation/task';

export const GET = withAuth(async ({ user, req }) => {
  const { taskId } = parseQuery(req, taskCompletionsQuerySchema);
  const completions = await listTaskCompletions(user.householdId!, taskId, {
    id: user.id,
    role: user.role,
  });
  return ok(completions);
});
