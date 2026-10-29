// Ringing a supervised child's phone (supervisionService.ringPhone) and what
// their phone says back: that it's ringing, then that Stop was tapped or that
// it rang out. Only the adult who rang sees it, on People you look after. The
// app shows the same words (data/Location.kt LookedAfterRing).

/** How long a phone rings unless Stop is tapped (the app's Ring.RING_MS). */
export const RING_MS = 30_000;

/** Firebase stops trying to reach an offline phone after this (the ring push's TTL). */
export const RING_TTL_MS = 60_000;

/** A little longer for the phone's word to arrive. */
const RING_GRACE_MS = 15_000;

/** How long the adult who rang sees how it went. */
export const RING_SHOWN_MS = 10 * 60_000;

/** What the phone reports: it started ringing, Stop was tapped, or it rang for RING_MS. */
export const RING_REPORTS = ['ringing', 'stopped', 'rang_out'] as const;

/**
 * sending: no word from their phone yet. ringing: it says it's ringing.
 * stopped / rang_out: it says how it ended. rang: it rang, but its word on
 * how it ended never came. no_answer: it never said it rang (off, no signal,
 * or an app from before ring confirmation).
 */
export type RingPhase = 'sending' | 'ringing' | 'stopped' | 'rang_out' | 'rang' | 'no_answer';

/** One ring as the server keeps it (epoch ms). */
export interface RingState {
  sentAt: number;
  ringingAt: number | null;
  endedAt: number | null;
  ended: 'stopped' | 'rang_out' | null;
}

export function ringPhase(ring: RingState, now: number): RingPhase {
  if (ring.ended) return ring.ended;
  if (ring.ringingAt !== null) return now - ring.ringingAt < RING_MS + RING_GRACE_MS ? 'ringing' : 'rang';
  return now - ring.sentAt < RING_TTL_MS + RING_GRACE_MS ? 'sending' : 'no_answer';
}

/** Still going: the page looks again every few seconds. */
export function ringActive(phase: RingPhase): boolean {
  return phase === 'sending' || phase === 'ringing';
}

/** Seconds it rang before Stop was tapped; null when that isn't known. */
export function stoppedAfterSec(ring: RingState): number | null {
  if (ring.ended !== 'stopped' || ring.ringingAt === null || ring.endedAt === null) return null;
  return Math.min(RING_MS / 1000, Math.max(1, Math.round((ring.endedAt - ring.ringingAt) / 1000)));
}

/** The outcome that follows "You rang 2 minutes ago:" in the ring status line. */
export function ringOutcome(ring: { phase: RingPhase; stoppedAfterSec: number | null }): string {
  switch (ring.phase) {
    case 'sending':
      return 'waiting for their phone to say it’s ringing';
    case 'ringing':
      return 'ringing on their phone now';
    case 'stopped':
      return ring.stoppedAfterSec === null
        ? 'Stop was tapped on their phone'
        : `Stop was tapped on their phone after ${ring.stoppedAfterSec} ${ring.stoppedAfterSec === 1 ? 'second' : 'seconds'}`;
    case 'rang_out':
      return `it rang for ${RING_MS / 1000} seconds and nobody tapped Stop`;
    case 'rang':
      return 'it rang on their phone';
    case 'no_answer':
      return 'their phone didn’t say it rang. It may be off or out of signal, or need the latest OurHome app.';
  }
}
