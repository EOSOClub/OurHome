import { ok, parseBody, withAuth } from '@/server/api/http';
import { fetchLinkPreview } from '@/server/services/linkPreview';
import { linkPreviewSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async ({ req }) => {
  const { url } = await parseBody(req, linkPreviewSchema);
  const preview = await fetchLinkPreview(url);
  return ok(preview);
});
