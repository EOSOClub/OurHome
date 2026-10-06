import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { addSubtask, taskToDTO } from '@/server/services/taskService';
import { createSubtaskSchema } from '@/lib/validation/task';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const input = await parseBody(ctx.req, createSubtaskSchema);
  const task = await addSubtask(ctx.user.householdId!, input);
  return ok(taskToDTO(task), { status: 201 });
});
