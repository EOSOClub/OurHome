// Which requests wait on someone - the dashboard's "Needs you" card. Mirrors
// the Android app's data/RequestAttention.kt (Requests tab badge + reminders):
// change both together.

import { REQUEST_MODULE_WORKFLOWS, isRequestCategory } from '@/lib/requestModules';

export type RequestAttentionReason =
  /** An open request of a kind they handle (approve workflow: media). */
  | 'approve'
  /** A maintenance request assigned to them, waiting for them to accept. */
  | 'accept'
  /** Maintenance they accepted whose done-by date is today or past. */
  | 'due';

export interface AttentionRequest {
  category: string;
  status: string | null;
  assigneeId: string | null;
  dueAt: Date | null;
}

/**
 * Why `userId` should act on `r` now, or null. `handles`: the approve-workflow
 * kinds they handle (Settings → Request types). The caller leaves out requests
 * of kinds that are turned off.
 * Media made before statuses existed has none (still waiting); "accepted"
 * media from the older two-step flow also still waits to be added; declined
 * and completed requests wait on nobody. `endOfToday` is the start of tomorrow
 * in the household's time zone.
 */
export function attentionReason(
  r: AttentionRequest,
  userId: string,
  handles: ReadonlySet<string>,
  endOfToday: Date,
): RequestAttentionReason | null {
  if (!isRequestCategory(r.category)) return null;
  if (r.status === 'completed' || r.status === 'declined') return null;
  if (REQUEST_MODULE_WORKFLOWS[r.category] === 'approve') {
    return handles.has(r.category) ? 'approve' : null;
  }
  if (r.assigneeId !== userId) return null;
  if ((r.status ?? 'pending') === 'pending') return 'accept';
  if (r.status === 'accepted' && r.dueAt && r.dueAt < endOfToday) return 'due';
  return null;
}
