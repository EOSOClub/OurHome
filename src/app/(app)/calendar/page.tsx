import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { listOccurrences } from '@/server/services/calendarService';
import { CalendarView } from '@/components/calendar/calendar-view';
import { getPointsSettings } from '@/server/services/pointsService';
import { fromWall } from '@/server/services/recurrenceService';
import { dateKey } from '@/lib/format';

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
  // "Now" and the month's bounds in the household's zone: this renders on the
  // server (UTC), and the browser shows the same month (HouseholdZoneProvider).
  const { timezone } = await getPointsSettings(householdId);
  const [nowYear, nowMonth] = dateKey(new Date(), timezone).split('-').map(Number);
  const year = match
    ? Number(match[1])
    : dMatch
      ? Number(dMatch[1])
      : nowYear;
  const month = match
    ? Number(match[2]) - 1
    : dMatch
      ? Number(dMatch[2]) - 1
      : nowMonth - 1;
  const start = fromWall(new Date(Date.UTC(year, month, 1)), timezone);
  const end = new Date(fromWall(new Date(Date.UTC(year, month + 1, 1)), timezone).getTime() - 1);

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
