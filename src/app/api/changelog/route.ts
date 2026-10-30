import { ok, withAuth } from '@/server/api/http';
import { unseenFor } from '@/server/services/changelogService';

// "What's new" entries this member hasn't closed on any device, newest first
// (the app asks on start; the website's layout reads them itself).
export const GET = withAuth(async ({ user }) => {
  return ok({ entries: await unseenFor(user.id) });
});
