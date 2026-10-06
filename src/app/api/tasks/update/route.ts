import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateTask, taskToDTO } from '@/server/services/taskService';
import { updateTaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const input = await parseBody(ctx.req, updateTaskSchema);
  const task = await updateTask(ctx.user.householdId!, ctx.user.id, input);
  return ok(taskToDTO(task));
});
