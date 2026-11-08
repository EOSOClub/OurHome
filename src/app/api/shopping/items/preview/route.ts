import { ok, parseBody, requireAnyAccess, withAuth } from '@/server/api/http';
import { fetchLinkPreview } from '@/server/services/linkPreview';
import { linkPreviewSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  // Only for someone who may use Shopping: the preview fills in the Add item
  // form and the edit row, so add-only would refuse an edit-only member.
  await requireAnyAccess(ctx, 'shopping');
  const { url } = await parseBody(ctx.req, linkPreviewSchema);
  const preview = await fetchLinkPreview(url);
  return ok(preview);
});
