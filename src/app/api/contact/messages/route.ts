import { ok, withServerAdmin } from '@/server/api/http';
import { listContactMessages } from '@/server/services/contactService';

// Public contact-form submissions aren't any household's data: server admin only.
export const GET = withServerAdmin(async ({ user }) => {
  const messages = await listContactMessages(user.id);
  return ok(messages);
});
