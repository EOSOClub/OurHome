import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { completeTask, taskToDTO } from '@/server/services/taskService';
import { completeTaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const input = await parseBody(ctx.req, completeTaskSchema);
  const task = await completeTask(
    ctx.user.householdId!,
    { id: ctx.user.id, role: ctx.user.role },
    input,
  );
  return ok(taskToDTO(task));
});
