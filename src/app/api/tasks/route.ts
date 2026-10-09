import {
  ok,
  parseBody,
  parseQuery,
  requireCreate,
  withAuth,
} from '@/server/api/http';
import { createTask, listTasks, taskDTO, taskDTOs } from '@/server/services/taskService';
import { createTaskSchema, listTasksQuerySchema } from '@/lib/validation/task';

export const GET = withAuth(async (ctx) => {
  const query = parseQuery(ctx.req, listTasksQuerySchema);
  const tasks = await listTasks(ctx.user.householdId!, query);
  return ok(await taskDTOs(ctx.user.householdId!, tasks));
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'tasks');
  const input = await parseBody(ctx.req, createTaskSchema);
  const task = await createTask(ctx.user.householdId!, ctx.user.id, input);
  return ok(await taskDTO(ctx.user.householdId!, task), { status: 201 });
});
