import {
  ok,
  parseBody,
  requireModify,
  requirePermission,
  withAuth,
} from '@/server/api/http';
import { updateSubtask, taskDTO } from '@/server/services/taskService';
import { recordOwner } from '@/server/services/permissionService';
import { updateSubtaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateSubtaskSchema);
  // Checking an item off is part of completing a task, so a bare done-toggle
  // only needs tasks:complete (guests included — the service scopes them to
  // their own assignments). Anything else edits the task's checklist.
  const doneToggleOnly =
    input.done !== undefined &&
    input.title === undefined &&
    input.position === undefined &&
    input.resetIntervalDays === undefined;
  if (doneToggleOnly) {
    requirePermission(ctx, 'tasks:complete');
  } else {
    await requireModify(
      ctx,
      'tasks',
      'edit',
      await recordOwner.subtask(householdId, input.subtaskId),
    );
  }
  const task = await updateSubtask(householdId, input, {
    id: ctx.user.id,
    role: ctx.user.role,
  });
  return ok(await taskDTO(householdId, task));
});
