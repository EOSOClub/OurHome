import { ok, parseBody, withAuth } from '@/server/api/http';
import { reportBattery } from '@/server/services/batteryService';
import { reportBatterySchema } from '@/lib/validation/location';

// The signed-in member's phone sending its battery level once an hour while they
// share their location. 409 when they don't: the phone stops sending.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportBatterySchema);
  await reportBattery(ctx.user.householdId!, ctx.user.id, input);
  return ok({ ok: true });
});
