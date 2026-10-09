import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { completeTask, taskDTO } from '@/server/services/taskService';
import { completeTaskSchema } from '@/lib/validation/task';

// Returns the task plus `completionId`, so the caller can offer Undo
// (POST /api/tasks/completions/undo). Older clients ignore the extra field.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const input = await parseBody(ctx.req, completeTaskSchema);
  const householdId = ctx.user.householdId!;
  const { task, completionId } = await completeTask(
    householdId,
    { id: ctx.user.id, role: ctx.user.role },
    input,
  );
  return ok({ ...(await taskDTO(householdId, task)), completionId });
});
