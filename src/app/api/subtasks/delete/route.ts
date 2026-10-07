import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteSubtask, taskToDTO } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { deleteSubtaskSchema } from '@/lib/validation/task';

// Removing a checklist item edits its task (not a task delete).
export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { subtaskId } = await parseBody(ctx.req, deleteSubtaskSchema);
  await requireModify(ctx, 'tasks', 'edit', await recordOwner.subtask(householdId, subtaskId));
  const task = await deleteSubtask(householdId, subtaskId);
  return ok(taskToDTO(task));
});
