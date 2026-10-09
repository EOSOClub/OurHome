import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { taskDTO, undoCompletion } from '@/server/services/taskService';
import { undoCompletionSchema } from '@/lib/validation/task';

// Undo a completion and void its points: the completer within 10 minutes,
// the head any time (taskService.undoCompletion enforces both).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const { completionId } = await parseBody(ctx.req, undoCompletionSchema);
  const householdId = ctx.user.householdId!;
  const task = await undoCompletion(householdId, { id: ctx.user.id, role: ctx.user.role }, completionId);
  return ok(await taskDTO(householdId, task));
});
