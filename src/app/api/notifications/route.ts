import { z } from 'zod';
import { ok, parseQuery, withAuth } from '@/server/api/http';
import { listNotifications } from '@/server/services/notificationService';
import { generateReminders } from '@/server/services/reminderService';
import { listNotificationsQuery } from '@/lib/validation/notification';

// `before` pages further back: pass the id of the oldest already-loaded
// notification to get the next-older page.
const listQuery = listNotificationsQuery.extend({
  before: z.string().cuid().optional(),
});

// Lazy-on-read generation: each fetch reconciles reminders from current state,
// so the system needs no external scheduler to stay current (the /api/cron
// route exists for scheduled sweeps + future out-of-app dispatch).
export const GET = withAuth(async ({ user, req }) => {
  const query = parseQuery(req, listQuery);
  await generateReminders(user.householdId!);
  const data = await listNotifications(user.householdId!, user.id, query);
  return ok(data);
});
