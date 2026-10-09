import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { getPointsSettings } from '@/server/services/pointsService';
import { listTasks, taskDTOs } from '@/server/services/taskService';
import { TasksView } from '@/components/tasks/tasks-view';

export default async function TasksPage() {
  const user = await requireUser();
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const [tasks, categories, members, settings] = await Promise.all([
    listTasks(householdId, {}),
    prisma.category.findMany({
      where: { householdId, kind: 'task' },
      select: { id: true, name: true, color: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    getPointsSettings(householdId),
  ]);

  return (
    <TasksView
      initialTasks={await taskDTOs(householdId, tasks)}
      categories={categories}
      members={members}
      access={access.tasks}
      userId={user.id}
      minutesPerPoint={settings.minutesPerPoint}
    />
  );
}
