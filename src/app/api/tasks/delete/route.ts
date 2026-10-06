import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteTask } from '@/server/services/taskService';
import { deleteTaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const { taskId } = await parseBody(ctx.req, deleteTaskSchema);
  await deleteTask(ctx.user.householdId!, ctx.user.id, taskId);
  return ok({ id: taskId });
});
