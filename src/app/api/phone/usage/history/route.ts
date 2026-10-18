import { ok, withAuth } from '@/server/api/http';
import { myUsageHistory } from '@/server/services/appUsageService';

// The signed-in member's own app usage, every stored day with all its apps,
// for their Profile on the web and in the app. 409 while it isn't shared.
export const GET = withAuth(async (ctx) => ok(await myUsageHistory(ctx.user.householdId!, ctx.user.id)));
