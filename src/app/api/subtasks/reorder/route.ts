import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { reorderSubtasks, taskToDTO } from '@/server/services/taskService';
import { reorderSubtasksSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const input = await parseBody(ctx.req, reorderSubtasksSchema);
  const task = await reorderSubtasks(ctx.user.householdId!, input);
  return ok(taskToDTO(task));
});
