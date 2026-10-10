import { ok, requirePermission, withAuth } from '@/server/api/http';
import { listContactMessages } from '@/server/services/contactService';

export const GET = withAuth(async (ctx) => {
  // Public-form submissions (not household data): Head of House only.
  requirePermission(ctx, 'household:manage');
  const messages = await listContactMessages();
  return ok(messages);
});
