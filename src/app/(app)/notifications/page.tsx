import { requireUser } from '@/server/auth/session';
import { listNotifications } from '@/server/services/notificationService';
import { generateReminders } from '@/server/services/reminderService';
import { NotificationsView } from '@/components/notifications/notifications-view';

export default async function NotificationsPage() {
  const user = await requireUser();
  const householdId = user.householdId!;

  // Reconcile reminders before the first paint so the page is current even
  // without an external scheduler (mirrors the GET /api/notifications route).
  await generateReminders(householdId);
  const data = await listNotifications(householdId, user.id, {
    unreadOnly: false,
    limit: 50,
  });

  return <NotificationsView initial={data} />;
}
