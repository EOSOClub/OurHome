import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { addSubtask, taskToDTO } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { createSubtaskSchema } from '@/lib/validation/task';

// Checklist items are part of their task: changing them edits the task.
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, createSubtaskSchema);
  await requireModify(ctx, 'tasks', 'edit', await recordOwner.task(householdId, input.taskId));
  const task = await addSubtask(householdId, input);
  return ok(taskToDTO(task), { status: 201 });
});
