import { fail, ok, rateLimit, readJsonCapped, requirePermission, withAuth } from '@/server/api/http';
import { completeTask, taskDTO } from '@/server/services/taskService';
import { COMPLETE_BODY_MAX_BYTES, completeTaskSchema } from '@/lib/validation/task';

// Returns the task plus `completionId`, so the caller can offer Undo
// (POST /api/tasks/completions/undo). Older clients ignore the extra field.
// A task sent for a check (Task Photo Proof) returns `completionId: null` and
// the check's `submissionId` instead (its Undo: POST /api/tasks/submissions/withdraw).
// The body may carry a photo, so it is read with a larger cap than other routes.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const input = completeTaskSchema.parse(await readJsonCapped(ctx.req, COMPLETE_BODY_MAX_BYTES));
  // Checks only: ordinary completions are never limited by this.
  if (input.forCheck && !rateLimit(`task-check:${ctx.user.id}`, 60_000, 10)) {
    return fail('That’s a lot of checks at once. Wait a minute, then try again.', 429);
  }
  const householdId = ctx.user.householdId!;
  const { task, completionId, submissionId } = await completeTask(
    householdId,
    { id: ctx.user.id, role: ctx.user.role },
    input,
  );
  return ok({ ...(await taskDTO(householdId, task)), completionId, submissionId: submissionId ?? null });
});
