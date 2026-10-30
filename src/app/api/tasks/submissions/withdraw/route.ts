import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getTaskOrThrow, taskDTO } from '@/server/services/taskService';
import { withdrawSubmission } from '@/server/services/taskSubmissionService';
import { withdrawSubmissionSchema } from '@/lib/validation/task';

// The child takes back their own waiting check (also the "Sent for a check"
// toast's Undo): the task is theirs to finish again and the photo is deleted.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'tasks:complete');
  const { submissionId } = await parseBody(ctx.req, withdrawSubmissionSchema);
  const householdId = ctx.user.householdId!;
  const taskId = await withdrawSubmission(householdId, { id: ctx.user.id, role: ctx.user.role }, submissionId);
  return ok(await taskDTO(householdId, await getTaskOrThrow(householdId, taskId), ctx.user.id));
});
