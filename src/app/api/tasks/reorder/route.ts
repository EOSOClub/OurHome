import { getAccess, ok, parseBody, withAuth } from '@/server/api/http';
import { reorderTasks } from '@/server/services/taskService';
import { ForbiddenError } from '@/server/services/errors';
import { reorderTasksSchema } from '@/lib/validation/task';

// The new order of the tasks in one place (Tasks page, grouped by room).
// Ordering is everyone's list, so it takes "Edit others'" on Tasks.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reorderTasksSchema);
  if (!(await getAccess(ctx)).tasks.editOthers) {
    throw new ForbiddenError('You can’t reorder the household’s tasks.');
  }
  await reorderTasks(ctx.user.householdId!, input);
  return ok({ taskIds: input.taskIds });
});
