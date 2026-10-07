import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';
import { hostnameOf, isHttpsRequest, isLoopbackHost } from '@/server/security/network';
import { can } from '@/lib/permissions';
import type { AccessSettingsDTO } from '@/lib/types';
import type { Actor } from '@/server/services/userService';

// "HTTPS only": the Head of House can refuse sign-in over plain HTTP, so
// passwords and session cookies never cross the home network unencrypted.
// http://localhost on the server itself always works, as the way back in.
// Only cookie sessions are affected; token-authenticated endpoints (Home
// Assistant webhooks and feed, cron) keep working over HTTP.

export const HTTPS_REQUIRED_MESSAGE =
  'This site only accepts sign-in over HTTPS. Use its https:// address, or http://localhost on the server itself.';

// The policy is read on every session lookup, so keep it in memory briefly.
const TTL_MS = 30_000;
let cached: { allowHttp: boolean; at: number } | null = null;

/** Plain-HTTP sign-in is allowed (true unless a household turned it off). */
export async function httpAllowed(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.allowHttp;
  const refusing = await prisma.household.findFirst({
    where: { allowHttp: false },
    select: { id: true },
  });
  cached = { allowHttp: !refusing, at: Date.now() };
  return cached.allowHttp;
}

/** How this request reached us. */
export function connectionOf(headers: Headers, url?: string): AccessSettingsDTO['connection'] {
  if (isHttpsRequest(headers, url)) return 'https';
  return isLoopbackHost(hostnameOf(headers.get('host') ?? '')) ? 'localhost' : 'http';
}

/** This request must be refused: plain HTTP from another device under HTTPS only. */
export async function isRefusedPlainHttp(headers: Headers, url?: string): Promise<boolean> {
  if (connectionOf(headers, url) !== 'http') return false;
  return !(await httpAllowed());
}

/** The configured public address, when it is an https:// one. */
function publicUrl(): string | null {
  const url = process.env.BETTER_AUTH_URL?.trim();
  return url?.startsWith('https://') ? url.replace(/\/+$/, '') : null;
}

export async function getAccessSettings(
  householdId: string,
  headers: Headers,
): Promise<AccessSettingsDTO> {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { allowHttp: true, accessReviewedAt: true },
  });
  if (!household) throw new NotFoundError('Household not found.');
  return {
    allowHttp: household.allowHttp !== false,
    reviewed: household.accessReviewedAt !== null,
    publicUrl: publicUrl(),
    connection: connectionOf(headers),
  };
}

/**
 * Save the choice. Turning plain HTTP off signs everyone else out, since their
 * session cookies may already have crossed the network unencrypted; the
 * caller's own session stays (it is cut off anyway if it is plain HTTP).
 */
export async function setAccessSettings(
  householdId: string,
  actor: Actor,
  allowHttp: boolean,
  currentSessionId: string | null,
  headers: Headers,
): Promise<AccessSettingsDTO> {
  if (!can(actor.role, 'household:manage')) {
    throw new ForbiddenError('Only the Head of House can change how the site is reached.');
  }
  const before = await prisma.household.findUnique({
    where: { id: householdId },
    select: { allowHttp: true },
  });
  if (!before) throw new NotFoundError('Household not found.');
  const turningOff = before.allowHttp !== false && !allowHttp;

  await prisma.$transaction(async (tx) => {
    await tx.household.update({
      where: { id: householdId },
      data: { allowHttp, accessReviewedAt: new Date() },
    });
    if (turningOff) {
      await tx.session.deleteMany({
        where: {
          user: { householdId },
          ...(currentSessionId ? { NOT: { id: currentSessionId } } : {}),
        },
      });
    }
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'household',
        subjectId: householdId,
        message: allowHttp
          ? 'allowed sign-in over the home network (HTTP)'
          : 'set sign-in to HTTPS only',
      },
      tx,
    );
  });

  cached = null;
  return getAccessSettings(householdId, headers);
}
