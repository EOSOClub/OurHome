import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateSubtask, taskToDTO } from '@/server/services/taskService';
import { updateSubtaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, updateSubtaskSchema);
  // Checking an item off is part of completing a task, so a bare done-toggle
  // only needs tasks:complete (guests included — the service scopes them to
  // their own assignments). Anything else edits the checklist: tasks:write.
  const doneToggleOnly =
    input.done !== undefined &&
    input.title === undefined &&
    input.position === undefined &&
    input.resetIntervalDays === undefined;
  requirePermission(ctx, doneToggleOnly ? 'tasks:complete' : 'tasks:write');
  const task = await updateSubtask(ctx.user.householdId!, input, {
    id: ctx.user.id,
    role: ctx.user.role,
  });
  return ok(taskToDTO(task));
});
