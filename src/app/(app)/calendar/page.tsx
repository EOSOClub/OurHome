import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { listOccurrences } from '@/server/services/calendarService';
import { CalendarView } from '@/components/calendar/calendar-view';

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ ym?: string | string[]; d?: string | string[] }>;
}) {
  const user = await requireUser();
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  // Restore the visible month from ?ym=YYYY-MM, falling back to the month of
  // the week-view anchor day (?d=YYYY-MM-DD), then to the current month.
  const { ym, d } = await searchParams;
  const match = typeof ym === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym) : null;
  const dMatch =
    typeof d === 'string' ? /^(\d{4})-(0[1-9]|1[0-2])-\d{2}$/.exec(d) : null;
  const now = new Date();
  const year = match
    ? Number(match[1])
    : dMatch
      ? Number(dMatch[1])
      : now.getFullYear();
  const month = match
    ? Number(match[2]) - 1
    : dMatch
      ? Number(dMatch[2]) - 1
      : now.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

  const [occurrences, members] = await Promise.all([
    listOccurrences(householdId, start, end),
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <CalendarView
      initialMonth={{ year, month }}
      initialOccurrences={occurrences}
      members={members}
      access={access.calendar}
      userId={user.id}
    />
  );
}
