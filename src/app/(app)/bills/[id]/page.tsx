import { notFound } from 'next/navigation';
import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { can } from '@/lib/permissions';
import { getBillDetail } from '@/server/services/billService';
import { NotFoundError } from '@/server/services/errors';
import { BillDetailView } from '@/components/bills/bill-detail-view';

// This customized Next.js resolves `params` asynchronously — await it.
export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const householdId = user.householdId!;

  let bill;
  try {
    bill = await getBillDetail(householdId, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const members = await prisma.user.findMany({
    where: { householdId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  return (
    <BillDetailView
      bill={bill}
      members={members}
      canWrite={can(user.role, 'bills:write')}
    />
  );
}
