import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteNfcTag } from '@/server/services/nfcService';
import { nfcTagIdSchema } from '@/lib/validation/nfc';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const { id } = await parseBody(ctx.req, nfcTagIdSchema);
  await deleteNfcTag(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
