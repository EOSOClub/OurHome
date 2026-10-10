import { requireFeature } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { listBills } from '@/server/services/billService';
import { BillsView } from '@/components/bills/bills-view';

export default async function BillsPage() {
  const user = await requireFeature('bills');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

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
