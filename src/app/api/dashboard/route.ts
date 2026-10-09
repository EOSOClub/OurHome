import { getAccess, ok, withAuth } from '@/server/api/http';
import { getDashboard } from '@/server/services/dashboardService';

export const GET = withAuth(async (ctx) => {
  const { user } = ctx;
  const data = await getDashboard({ id: user.id, householdId: user.householdId! }, await getAccess(ctx));
  return ok(data);
});
