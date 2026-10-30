import { ok, parseBody, requireCreate, requireFeatureOn, withAuth } from '@/server/api/http';
import { createBill, listBills } from '@/server/services/billService';
import { createBillSchema } from '@/lib/validation/bills';

export const GET = withAuth(async (ctx) => {
  const bills = await listBills(ctx.user.householdId!);
  return ok(bills);
});

export const POST = withAuth(async (ctx) => {
  await requireCreate(ctx, 'bills');
  const input = await parseBody(ctx.req, createBillSchema);
  // Made on the calendar, it goes on the calendar too.
  if (input.onCalendar) {
    await requireFeatureOn(ctx, 'calendar');
    await requireCreate(ctx, 'calendar');
  }
  const bill = await createBill(ctx.user.householdId!, ctx.user.id, input);
  return ok(bill, { status: 201 });
});
