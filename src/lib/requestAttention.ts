// Which requests wait on someone — the dashboard's "Needs you" card. Mirrors
// the Android app's data/RequestAttention.kt (Requests tab badge + reminders):
// change both together.

export type RequestAttentionReason =
  /** An open media request and they mark media added (Requests "Approve"). */
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
 * Why `userId` should act on `r` now, or null. Media made before statuses
 * existed has none (still waiting); "accepted" media from the older two-step
 * flow also still waits to be added. `endOfToday` is the start of tomorrow in
 * the household's time zone.
 */
export function attentionReason(
  r: AttentionRequest,
  userId: string,
  approvesMedia: boolean,
  endOfToday: Date,
): RequestAttentionReason | null {
  if (r.category === 'media') {
    return approvesMedia && r.status !== 'completed' ? 'approve' : null;
  }
  if (r.category !== 'maintenance' || r.assigneeId !== userId) return null;
  if ((r.status ?? 'pending') === 'pending') return 'accept';
  if (r.status === 'accepted' && r.dueAt && r.dueAt < endOfToday) return 'due';
  return null;
}
