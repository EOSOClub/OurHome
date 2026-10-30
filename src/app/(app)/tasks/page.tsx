import { requireFeature } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { getPointsSettings } from '@/server/services/pointsService';
import { listTasks, taskDTOs } from '@/server/services/taskService';
import { listPlaces } from '@/server/services/placeService';
import { isSupervisedChild } from '@/server/services/taskReviewService';
import { listSubmissions } from '@/server/services/taskSubmissionService';
import { supervisedIds } from '@/server/services/supervisionService';
import { TasksView } from '@/components/tasks/tasks-view';

export default async function TasksPage() {
  const user = await requireFeature('tasks');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  // Task Photo Proof: each task says itself whether Complete goes through a
  // check for this viewer (review.checkForMe, so the viewer is passed to
  // taskDTOs below). Here only: whether "Ask for a photo" is theirs to
  // change, and To check for someone who looks after anyone, read before the
  // page renders so nothing pops in.
  const [supervised, looksAfter] = await Promise.all([
    isSupervisedChild(prisma, householdId, user.id),
    supervisedIds(householdId, user.id),
  ]);
  const isHead = user.role === 'head';
  const initialSubmissions = looksAfter.size > 0 ? await listSubmissions(householdId, user.id) : null;

  const [tasks, categories, members, settings, places] = await Promise.all([
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
    listPlaces(householdId),
  ]);

  return (
    <TasksView
      initialTasks={await taskDTOs(householdId, tasks, user.id)}
      categories={categories}
      places={places}
      members={members}
      access={access.tasks}
      userId={user.id}
      minutesPerPoint={settings.minutesPerPoint}
      supervised={supervised}
      isHead={isHead}
      initialSubmissions={initialSubmissions}
    />
  );
}
