import { ok, withAuth } from '@/server/api/http';
import { listPlaces } from '@/server/services/placeService';

// Every floor and room, in the household's order. Anyone in the household.
export const GET = withAuth(async (ctx) => ok(await listPlaces(ctx.user.householdId!)));
