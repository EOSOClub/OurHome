import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { reorderSubtasks, taskToDTO } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { reorderSubtasksSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, reorderSubtasksSchema);
  await requireModify(ctx, 'tasks', 'edit', await recordOwner.task(householdId, input.taskId));
  const task = await reorderSubtasks(householdId, input);
  return ok(taskToDTO(task));
});
