import { requireUser } from '@/server/auth/session';
import { listNotifications } from '@/server/services/notificationService';
import { refreshRemindersForRead } from '@/server/services/reminderService';
import { NotificationsView } from '@/components/notifications/notifications-view';

export default async function NotificationsPage() {
  const user = await requireUser();
  const householdId = user.householdId!;

  // Reconcile reminders before the first paint so the page is current between
  // sweeps (mirrors the GET /api/notifications route, including sharing or
  // skipping a rebuild that is going or ran in the last minute).
  await refreshRemindersForRead(householdId);
  const data = await listNotifications(householdId, user.id, {
    unreadOnly: false,
    limit: 50,
  });

  return <NotificationsView initial={data} />;
}
