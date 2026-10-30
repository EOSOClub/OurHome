import { parseQuery, withAuth } from '@/server/api/http';
import { submissionPhoto } from '@/server/services/taskSubmissionService';
import { submissionPhotoQuerySchema } from '@/lib/validation/task';

// A check's photo, loaded only when its To check item is opened. Only for the
// child who sent it and the adults who look after them now (404 for anyone
// else). Kept by the browser for 5 minutes, never shared; sandboxed, so the
// bytes can only ever be shown as an image.
export const GET = withAuth(async (ctx) => {
  const { id } = parseQuery(ctx.req, submissionPhotoQuerySchema);
  const jpeg = await submissionPhoto(ctx.user.householdId!, ctx.user.id, id);
  return new Response(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
