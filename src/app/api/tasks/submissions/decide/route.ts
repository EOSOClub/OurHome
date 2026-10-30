import { ok, parseBody, withAuth } from '@/server/api/http';
import { getTaskOrThrow, taskDTO } from '@/server/services/taskService';
import { decideSubmission } from '@/server/services/taskSubmissionService';
import { decideSubmissionSchema } from '@/lib/validation/task';

// An adult who looks after the child approves a check or sends it back (or,
// for one counted as done when its day ended, takes its points back). The
// service refuses anyone who doesn't look after them right now. Returns the
// task, plus `completionId` after an approval so the adult can Undo it.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, decideSubmissionSchema);
  const householdId = ctx.user.householdId!;
  const { taskId, completionId } = await decideSubmission(householdId, { id: ctx.user.id, role: ctx.user.role }, input);
  return ok({ ...(await taskDTO(householdId, await getTaskOrThrow(householdId, taskId))), completionId });
});
