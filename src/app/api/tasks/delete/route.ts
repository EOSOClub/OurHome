import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteTask } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { deleteTaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { taskId } = await parseBody(ctx.req, deleteTaskSchema);
  await requireModify(ctx, 'tasks', 'delete', await recordOwner.task(householdId, taskId));
  await deleteTask(householdId, ctx.user.id, taskId);
  return ok({ id: taskId });
});
