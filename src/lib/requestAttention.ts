// Which requests wait on someone - the dashboard's "Needs you" card. Mirrors
// the Android app's data/RequestAttention.kt (Requests tab badge + reminders):
// change both together.

import { REQUEST_MODULE_WORKFLOWS, isRequestCategory } from '@/lib/requestModules';

export type RequestAttentionReason =
  /** An open request of a kind they decide (approve workflow: media, purchase, permission). */
  | 'approve'
  /** A maintenance request assigned to them, waiting for them to accept. */
  | 'accept'
  /** Maintenance they accepted whose done-by date is today or past. */
  | 'due';

export interface AttentionRequest {
  category: string;
  status: string | null;
  requesterId: string;
  assigneeId: string | null;
  dueAt: Date | null;
}

/** Who decides which approve-workflow requests, from one member's side (Settings → Request types). */
export interface RequestDeciding {
  /** Approve-workflow kinds they handle (for requesters the supervisor rule doesn't cover). */
  handles: ReadonlySet<string>;
  /** Kinds where a request from someone with supervisors goes to those supervisors. */
  bySupervisors: ReadonlySet<string>;
  /** Members who have supervisors. */
  supervised: ReadonlySet<string>;
  /** Members this member supervises. */
  supervising: ReadonlySet<string>;
}

/**
 * Why `userId` should act on `r` now, or null. The caller leaves out requests
 * of kinds that are turned off.
 * Media made before statuses existed has none (still waiting); "accepted"
 * media from the older two-step flow also still waits to be added; declined
 * and completed requests wait on nobody. `endOfToday` is the start of tomorrow
 * in the household's time zone.
 */
export function attentionReason(
  r: AttentionRequest,
  userId: string,
  deciding: RequestDeciding,
  endOfToday: Date,
): RequestAttentionReason | null {
  if (!isRequestCategory(r.category)) return null;
  if (r.status === 'completed' || r.status === 'declined') return null;
  if (REQUEST_MODULE_WORKFLOWS[r.category] === 'approve') {
    const decides =
      deciding.bySupervisors.has(r.category) && deciding.supervised.has(r.requesterId)
        ? deciding.supervising.has(r.requesterId)
        : deciding.handles.has(r.category);
    return decides ? 'approve' : null;
  }
  if (r.assigneeId !== userId) return null;
  if ((r.status ?? 'pending') === 'pending') return 'accept';
  if (r.status === 'accepted' && r.dueAt && r.dueAt < endOfToday) return 'due';
  return null;
}
