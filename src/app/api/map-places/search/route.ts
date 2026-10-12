import { fail, ok, parseQuery, rateLimit, requirePermission, withAuth } from '@/server/api/http';
import { searchAddress } from '@/server/services/mapPlaceService';
import { searchAddressSchema } from '@/lib/validation/location';

// Look up an address for the map place pin picker (OpenStreetMap Nominatim).
// Head of House and managers. Nominatim allows one request a second, so the
// limit is for the whole server, not per person.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const { q } = parseQuery(ctx.req, searchAddressSchema);
  if (!rateLimit('nominatim', 1000, 1)) return fail('Searching too fast. Try again in a second.', 429);
  return ok(await searchAddress(q));
});
