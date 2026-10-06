import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { listNfcTags, registerNfcTag } from '@/server/services/nfcService';
import { registerNfcTagSchema } from '@/lib/validation/nfc';

export const GET = withAuth(async ({ user }) => {
  const tags = await listNfcTags(user.householdId!);
  return ok(tags);
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const input = await parseBody(ctx.req, registerNfcTagSchema);
  const tag = await registerNfcTag(ctx.user.householdId!, ctx.user.id, input);
  return ok(tag, { status: 201 });
});
