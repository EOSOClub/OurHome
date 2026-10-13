import { ok, withAuth } from '@/server/api/http';
import { lookAfterOverview } from '@/server/services/supervisionService';

// The children and teens the signed-in adult supervises, with their location
// sharing, for the Map's "People you look after" card. Empty for everyone else.
export const GET = withAuth(async (ctx) => ok(await lookAfterOverview(ctx.user.householdId!, ctx.user.id)));
