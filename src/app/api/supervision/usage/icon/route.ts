import { parseQuery, withAuth } from '@/server/api/http';
import { usageIcon } from '@/server/services/supervisionService';
import { usageIconQuerySchema } from '@/lib/validation/supervision';

// An app's icon next to a child's app usage on "People you look after". Only
// for an adult who supervises a child whose shared usage names the app (404
// otherwise). Kept by the browser for a day: icons rarely change.
export const GET = withAuth(async (ctx) => {
  const { app } = parseQuery(ctx.req, usageIconQuerySchema);
  const png = await usageIcon(ctx.user.householdId!, ctx.user.id, app);
  return new Response(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
