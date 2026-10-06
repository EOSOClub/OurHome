import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteSubtask, taskToDTO } from '@/server/services/taskService';
import { deleteSubtaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const { subtaskId } = await parseBody(ctx.req, deleteSubtaskSchema);
  const task = await deleteSubtask(ctx.user.householdId!, subtaskId);
  return ok(taskToDTO(task));
});
