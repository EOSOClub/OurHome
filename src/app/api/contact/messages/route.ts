import { ok, requirePermission, withAuth } from '@/server/api/http';
import { listContactMessages } from '@/server/services/contactService';

export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const messages = await listContactMessages();
  return ok(messages);
});
