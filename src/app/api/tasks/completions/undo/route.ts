import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { taskDTO, undoCompletion } from '@/server/services/taskService';
import { undoCompletionSchema } from '@/lib/validation/task';

// Undo a completion and void its points: the completer within 10 minutes,
// the head any time (taskService.undoCompletion enforces both). One an
// approved check paid: the adult who approved it within 10 minutes, or the
// head. `undo` says what happened, for the toast: "back_to_check" (waiting
// for an OK again) or "undone".
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const { completionId } = await parseBody(ctx.req, undoCompletionSchema);
  const householdId = ctx.user.householdId!;
  const { task, outcome } = await undoCompletion(householdId, { id: ctx.user.id, role: ctx.user.role }, completionId);
  return ok({ ...(await taskDTO(householdId, task)), undo: outcome });
});
