import { ok, withAuth } from '@/server/api/http';
import { getDashboard } from '@/server/services/dashboardService';

export const GET = withAuth(async ({ user }) => {
  const data = await getDashboard(user.householdId!);
  return ok(data);
});
