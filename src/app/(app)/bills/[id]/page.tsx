import { notFound } from 'next/navigation';
import { requireFeature } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getUserAccess } from '@/server/services/permissionService';
import { getBillDetail } from '@/server/services/billService';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { NotFoundError } from '@/server/services/errors';
import { BillDetailView } from '@/components/bills/bill-detail-view';

// This customized Next.js resolves `params` asynchronously - await it.
export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireFeature('bills');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  let bill;
  try {
    bill = await getBillDetail(householdId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const [members, features] = await Promise.all([
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    getHouseholdFeatures(householdId),
  ]);

  return (
    <BillDetailView
      bill={bill}
      members={members}
      access={access.bills}
      userId={user.id}
      // Putting it on the calendar needs Calendar on and its Add access.
      canAddToCalendar={features.includes('calendar') && access.calendar.create}
    />
  );
}
