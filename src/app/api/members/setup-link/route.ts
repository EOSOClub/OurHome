import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { createSetupLink } from '@/server/services/setupLinkService';
import { setupLinkSchema } from '@/lib/validation/user';

// Set up a child's Install step: a new setup link (QR code) for one child's
// phone, replacing the last. Head of House only, like the wizard.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const { memberId } = await parseBody(ctx.req, setupLinkSchema);
  return ok(await createSetupLink(ctx.user.householdId!, ctx.user, memberId, ctx.req.url));
});
