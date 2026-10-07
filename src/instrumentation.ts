// Runs once when the Next.js server starts, and must finish before the server
// takes requests (see the Next docs for instrumentation.ts):
//
//   1. Reads settings.yml and the .env secrets into the environment, before
//      any code that uses them.
//   2. On the production server, starts the in-process reminder sweep (every 15
//      minutes). Not during `next build`, and not in `next dev`, which points at
//      the live database. One sweep schedule, on the server, is enough.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { describeLoad, loadSettings } = await import('@/server/settings');
  console.log(describeLoad(loadSettings()));

  if (process.env.NODE_ENV !== 'production') return;
  const { startReminderSchedule } = await import('@/server/services/reminderSweep');
  startReminderSchedule();
}
