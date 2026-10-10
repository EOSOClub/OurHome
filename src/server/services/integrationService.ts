import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '@/server/db/prisma';
import type { IntegrationDTO } from '@/lib/types';
import { logActivity } from '@/server/services/activityService';
import { NotFoundError } from '@/server/services/errors';
import { isHouseholdDisabled } from '@/server/services/serverAdminService';

// Webhook tokens are high-entropy random strings; we only store their SHA-256
// hash. The plaintext is shown to the user exactly once at creation time.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toDTO(integration: {
  id: string;
  name: string;
  active: boolean;
  createdAt: Date;
}): IntegrationDTO {
  return {
    id: integration.id,
    name: integration.name,
    active: integration.active,
    createdAt: integration.createdAt.toISOString(),
  };
}

export async function listIntegrations(
  householdId: string,
): Promise<IntegrationDTO[]> {
  const rows = await prisma.homeAssistantIntegration.findMany({
    where: { householdId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toDTO);
}

export interface CreatedIntegration {
  integration: IntegrationDTO;
  /** Plaintext token — returned once, never stored. */
  token: string;
}

export async function createIntegration(
  householdId: string,
  userId: string,
  name: string,
): Promise<CreatedIntegration> {
  const token = randomBytes(32).toString('base64url');
  const integration = await prisma.homeAssistantIntegration.create({
    data: { householdId, name, tokenHash: hashToken(token), active: true },
  });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'created',
    subjectType: 'integration',
    subjectId: integration.id,
    message: `created Home Assistant connection “${name}”`,
  });

  return { integration: toDTO(integration), token };
}

export async function deleteIntegration(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const integration = await prisma.homeAssistantIntegration.findFirst({
    where: { id, householdId },
  });
  if (!integration) throw new NotFoundError(`Integration ${id} not found.`);

  await prisma.homeAssistantIntegration.delete({ where: { id } });

  await logActivity({
    householdId,
    actorId: userId,
    verb: 'deleted',
    subjectType: 'integration',
    subjectId: id,
    message: `revoked Home Assistant connection “${integration.name}”`,
  });
}

/**
 * Read an integration token from a request: `Authorization: Bearer <token>`,
 * falling back to `x-ha-token`. Shared by the HA webhook and HA display feed.
 */
export function extractIntegrationToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return req.headers.get('x-ha-token')?.trim() || null;
}

/** Resolve the household behind a webhook bearer token, or null if invalid. */
export async function resolveHouseholdByToken(
  token: string,
): Promise<{ householdId: string; integrationId: string } | null> {
  if (!token) return null;
  const integration = await prisma.homeAssistantIntegration.findFirst({
    where: { tokenHash: hashToken(token), active: true },
    select: { id: true, householdId: true },
  });
  if (!integration) return null;
  // A turned-off household's webhooks and feeds stop too.
  if (await isHouseholdDisabled(integration.householdId)) return null;
  return { householdId: integration.householdId, integrationId: integration.id };
}
