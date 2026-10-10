import { ok, withAuth } from '@/server/api/http';
import { listContactMessages } from '@/server/services/contactService';
import { assertServerAdmin } from '@/server/services/serverAdminService';

// Public contact-form submissions aren't any household's data: server admin only.
export const GET = withAuth(async (ctx) => {
  await assertServerAdmin(ctx.user.id);
  const messages = await listContactMessages();
  return ok(messages);
});
