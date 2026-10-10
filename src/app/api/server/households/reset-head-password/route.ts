import { ok, parseBody, withServerAdmin } from '@/server/api/http';
import { resetHeadPassword } from '@/server/services/serverAdminService';
import { resetHeadPasswordSchema } from '@/lib/validation/server';

// A new temporary password for a household's Head of House. Server admin only.
export const POST = withServerAdmin(async (ctx) => {
  const input = await parseBody(ctx.req, resetHeadPasswordSchema);
  await resetHeadPassword(ctx.user.id, input);
  return ok({ id: input.id });
});
