import { recordId } from '@/lib/validation/ids';
import { ok, parseQuery, withAuth } from '@/server/api/http';
import { listNotifications } from '@/server/services/notificationService';
import { refreshRemindersForRead } from '@/server/services/reminderService';
import { listNotificationsQuery } from '@/lib/validation/notification';

// `before` pages further back: pass the id of the oldest already-loaded
// notification to get the next-older page.
const listQuery = listNotificationsQuery.extend({
  before: recordId.optional(),
});

// Lazy-on-read generation: a fetch reconciles reminders from current state,
// so the bell stays current between the 15-minute sweeps. The bell polls every
// minute in every open tab, so a fetch shares a rebuild already going and
// skips one that ran in the last minute (refreshRemindersForRead): overlapping
// rebuilds emailed the same reminder twice.
export const GET = withAuth(async ({ user, req }) => {
  const query = parseQuery(req, listQuery);
  await refreshRemindersForRead(user.householdId!);
  const data = await listNotifications(user.householdId!, user.id, query);
  return ok(data);
});
