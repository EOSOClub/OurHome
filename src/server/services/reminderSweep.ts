import { prisma } from '@/server/db/prisma';
import { generateReminders } from '@/server/services/reminderService';
import { resetDueSubtasks, rollTaskCycles } from '@/server/services/taskService';
import { runPaperlessSync } from '@/server/services/paperlessSync';
import { announceAppRelease } from '@/server/services/appReleaseService';

// One reminder sweep over every household. Runs every 15 minutes inside the
// production server (startReminderSchedule, from src/instrumentation.ts) and on
// demand via POST /api/cron/reminders.
export async function runReminderSweep(): Promise<{ households: number }> {
  // Import new bills from Paperless first, so this sweep's bill-due reminders
  // already include them. Off unless configured; a Paperless problem is
  // logged (and shown in Settings) but never stops the reminders.
  await runPaperlessSync().catch((err) => {
    console.warn('[paperless] import failed; retrying next sweep:', err instanceof Error ? err.message : err);
  });

  // A new Android app build (from the deploy) → tell everyone, once per version.
  await announceAppRelease().catch((err) => {
    console.warn('[app] announcing the new app failed; retrying next sweep:', err instanceof Error ? err.message : err);
  });

  const households = await prisma.household.findMany({ select: { id: true } });
  for (const { id } of households) {
    // Roll finished task cycles over (missed ones are recorded and their queued
    // points dropped), then flip recurring checklist items back, so this
    // sweep's reminders see the current state.
    await rollTaskCycles(id);
    await resetDueSubtasks(id);
    await generateReminders(id);
  }
  return { households: households.length };
}

const INTERVAL_MS = 15 * 60 * 1000;
// Give the server a minute to finish booting (and Mongo to be reachable)
// before the first sweep.
const FIRST_RUN_DELAY_MS = 60 * 1000;

// Survives module re-evaluation, so register() running twice can't start a
// second timer.
const scheduleState = globalThis as typeof globalThis & { __reminderSchedule?: boolean };

export function startReminderSchedule(): void {
  if (scheduleState.__reminderSchedule) return;
  scheduleState.__reminderSchedule = true;

  let running = false;
  const tick = async () => {
    // A slow sweep must not overlap the next one.
    if (running) return;
    running = true;
    try {
      const { households } = await runReminderSweep();
      console.log(`[reminders] sweep done (${households} households)`);
    } catch (err) {
      // Same as the old cron container: log and retry on the next interval.
      console.error('[reminders] sweep failed; retrying next interval', err);
    } finally {
      running = false;
    }
  };

  console.log('[reminders] in-app sweep scheduled every 15 minutes');
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}
