import { prisma } from '@/server/db/prisma';
import { generateReminders } from '@/server/services/reminderService';
import { resetDueSubtasks } from '@/server/services/taskService';

// One reminder sweep over every household. Runs every 15 minutes inside the
// production server (startReminderSchedule, from src/instrumentation.ts) and on
// demand via POST /api/cron/reminders.
export async function runReminderSweep(): Promise<{ households: number }> {
  const households = await prisma.household.findMany({ select: { id: true } });
  for (const { id } of households) {
    // Flip recurring checklist items back first so an item that just became
    // "not done" can be reflected in this sweep's reminders.
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
