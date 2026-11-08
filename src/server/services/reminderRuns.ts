// Shared state for reminder rebuilds (reminderService): which run is going for
// each household, and when the last good one started. Its own module so the
// activity log can mark a household's reminders stale without importing
// reminderService, which would close an import cycle (reminderService imports
// services that log activity).
//
// Kept on globalThis, like the sweep's own timer, so the sweep started from
// instrumentation and the routes share it even if a module loads twice.

export interface ReminderRuns {
  /** The latest run started (or queued) for each household. */
  inFlight: Map<string, Promise<void>>;
  /** When that latest run was asked for (Date.now()). */
  requestedAt: Map<string, number>;
  /** When each household's last run that didn't fail started (Date.now()). */
  lastStarted: Map<string, number>;
  /** When the household was last marked stale (Date.now()). */
  staleAt: Map<string, number>;
}

const holder = globalThis as typeof globalThis & { __reminderRuns?: ReminderRuns };
const runs = (holder.__reminderRuns ??= {
  inFlight: new Map(),
  requestedAt: new Map(),
  lastStarted: new Map(),
  staleAt: new Map(),
});
// A module loaded before these maps existed (dev reload) gets them now.
runs.requestedAt ??= new Map();
runs.staleAt ??= new Map();
export const reminderRuns: ReminderRuns = runs;

/**
 * How long after a stale mark a run still doesn't count as fresh. The mark is
 * made by logActivity, which usually runs inside the change's own transaction,
 * so a run that starts in the moment before that transaction commits reads
 * the old state; without this, it would be taken as fresh for a minute.
 */
export const STALE_GRACE_MS = 5_000;

/**
 * Something changed in the household (a bill paid, a task done, stock
 * restocked, the time zone): the next read rebuilds its reminders instead of
 * skipping or sharing a run that was asked for before the change, so a
 * reminder whose cause was just fixed leaves the bell at once.
 */
export function markRemindersStale(householdId: string): void {
  reminderRuns.staleAt.set(householdId, Date.now());
  reminderRuns.lastStarted.delete(householdId);
}
