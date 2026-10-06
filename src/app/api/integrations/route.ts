import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import {
  createIntegration,
  listIntegrations,
} from '@/server/services/integrationService';
import { createIntegrationSchema } from '@/lib/validation/integration';

export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const integrations = await listIntegrations(ctx.user.householdId!);
  return ok(integrations);
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const { name } = await parseBody(ctx.req, createIntegrationSchema);
  // Returns the plaintext token once — the client must surface it immediately.
  const result = await createIntegration(ctx.user.householdId!, ctx.user.id, name);
  return ok(result, { status: 201 });
});
