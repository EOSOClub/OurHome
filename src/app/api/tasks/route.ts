import {
  ok,
  parseBody,
  parseQuery,
  requirePermission,
  withAuth,
} from '@/server/api/http';
import { createTask, listTasks, taskToDTO } from '@/server/services/taskService';
import { createTaskSchema, listTasksQuerySchema } from '@/lib/validation/task';

export const GET = withAuth(async (ctx) => {
  const query = parseQuery(ctx.req, listTasksQuerySchema);
  const tasks = await listTasks(ctx.user.householdId!, query);
  return ok(tasks.map(taskToDTO));
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:write');
  const input = await parseBody(ctx.req, createTaskSchema);
  const task = await createTask(ctx.user.householdId!, ctx.user.id, input);
  return ok(taskToDTO(task), { status: 201 });
});
