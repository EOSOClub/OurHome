import { requireFeature } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { listBills } from '@/server/services/billService';
import { getPointsSettings } from '@/server/services/pointsService';
import { localDateOf, startOfLocalDate } from '@/lib/taskCycles';
import { BillsView } from '@/components/bills/bills-view';

export default async function BillsPage() {
  const user = await requireFeature('bills');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  // "This month" in the household's zone, not the server's: this renders on
  // the server (UTC in Docker), where the month turned over at 18:00 or 19:00
  // the evening before in Chicago, and payments made in that gap counted
  // toward the wrong month.
  const { timezone } = await getPointsSettings(householdId);
  const today = localDateOf(new Date(), timezone);
  const startOfMonth = startOfLocalDate({ year: today.year, month: today.month, day: 1 }, timezone);

  const [bills, members, paidAgg] = await Promise.all([
    listBills(householdId),
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.billPayment.aggregate({
      where: { householdId, paidAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
  ]);

  return (
    <BillsView
      initialBills={bills}
      members={members}
      access={access.bills}
      userId={user.id}
      paidThisMonth={paidAgg._sum.amount ?? 0}
    />
  );
}
