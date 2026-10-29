import { prisma } from '@/server/db/prisma';
import { getPointsSettings } from '@/server/services/pointsService';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { isDateOnly, isOverdue } from '@/lib/format';
import type { CalendarChoreDTO } from '@/lib/types';

// Things from other pages shown on the calendar, read-only. Today: chores, at
// their current due date only. A repeating chore's later dates aren't shown,
// because finishing it (or finishing it late) is what sets the next one.

const ACTIVE_STATUSES = ['pending', 'in_progress'];

/** Open chores due within [start, end]; none when Tasks is turned off. */
export async function listChoreItems(
  householdId: string,
  start: Date,
  end: Date,
  now = new Date(),
): Promise<CalendarChoreDTO[]> {
  const features = await getHouseholdFeatures(householdId);
  if (!features.includes('tasks')) return [];
  const [tasks, { timezone }] = await Promise.all([
    prisma.task.findMany({
      where: { householdId, status: { in: ACTIVE_STATUSES }, dueDate: { gte: start, lte: end } },
      select: {
        id: true,
        title: true,
        dueDate: true,
        assigneeId: true,
        assignee: { select: { name: true } },
      },
      orderBy: { dueDate: 'asc' },
    }),
    getPointsSettings(householdId),
  ]);
  return tasks
    .filter((t): t is typeof t & { dueDate: Date } => t.dueDate !== null)
    .map((t) => ({
      id: t.id,
      title: t.title,
      due: t.dueDate.toISOString(),
      allDay: isDateOnly(t.dueDate, timezone),
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      overdue: isOverdue(t.dueDate, timezone, now),
    }));
}
