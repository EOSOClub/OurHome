// Runs once when the Next.js server starts. Starts the in-process reminder
// sweep (every 15 minutes), which replaced the separate reminder-cron container.
//
// Production server only: not during `next build`, and not in `next dev`, which
// points at the live database. One sweep schedule, on the server, is enough.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { startReminderSchedule } = await import('@/server/services/reminderSweep');
  startReminderSchedule();
}
