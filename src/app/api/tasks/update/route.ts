import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updateTask, taskToDTO } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { updateTaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateTaskSchema);
  await requireModify(ctx, 'tasks', 'edit', await recordOwner.task(householdId, input.taskId));
  const task = await updateTask(householdId, ctx.user.id, input);
  return ok(taskToDTO(task));
});
