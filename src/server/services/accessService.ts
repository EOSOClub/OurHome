import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { hostnameOf, isHttpsRequest, isLoopbackHost } from '@/server/security/network';
import type { AccessSettingsDTO } from '@/lib/types';
import { assertServerAdmin } from '@/server/services/serverAdminService';

// "HTTPS only": the server admin can refuse sign-in over plain HTTP, so
// passwords and session cookies never cross the network unencrypted.
// http://localhost on the server itself always works, as the way back in.
// Only cookie sessions are affected; token-authenticated endpoints (Home
// Assistant webhooks and feed, cron) keep working over HTTP. It's checked
// before anyone signs in, so it is server-wide (ServerSettings), not per
// household.

export const HTTPS_REQUIRED_MESSAGE =
  'This site only accepts sign-in over HTTPS. Use its https:// address, or http://localhost on the server itself.';

const SERVER_ID = 'server';

// The policy is read on every session lookup, so keep it in memory briefly.
const TTL_MS = 30_000;
let cached: { allowHttp: boolean; at: number } | null = null;

/**
 * The saved server-wide choice. Before the server admin first saves it, the
 * old per-household setting still applies (any household that refused plain
 * HTTP refused it for everyone — the behaviour this replaced).
 */
async function currentPolicy(): Promise<{ allowHttp: boolean; reviewed: boolean }> {
  const row = await prisma.serverSettings.findUnique({ where: { id: SERVER_ID } });
  if (row) return { allowHttp: row.allowHttp !== false, reviewed: row.accessReviewedAt !== null };
  const [refusing, reviewed] = await Promise.all([
    prisma.household.findFirst({ where: { allowHttp: false }, select: { id: true } }),
    prisma.household.findFirst({ where: { accessReviewedAt: { not: null } }, select: { accessReviewedAt: true } }),
  ]);
  return { allowHttp: !refusing, reviewed: !!reviewed?.accessReviewedAt };
}

/** Plain-HTTP sign-in is allowed. */
export async function httpAllowed(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.allowHttp;
  const { allowHttp } = await currentPolicy();
  cached = { allowHttp, at: Date.now() };
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

export async function getAccessSettings(headers: Headers): Promise<AccessSettingsDTO> {
  const { allowHttp, reviewed } = await currentPolicy();
  return { allowHttp, reviewed, publicUrl: publicUrl(), connection: connectionOf(headers) };
}

/**
 * Save the choice (server admin only). Turning plain HTTP off signs everyone
 * else on the server out, since their session cookies may already have crossed
 * the network unencrypted; the caller's own session stays (it is cut off
 * anyway if it is plain HTTP).
 */
export async function setAccessSettings(
  adminId: string,
  allowHttp: boolean,
  currentSessionId: string | null,
  headers: Headers,
): Promise<AccessSettingsDTO> {
  await assertServerAdmin(adminId);
  const before = await currentPolicy();
  const turningOff = before.allowHttp && !allowHttp;
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { householdId: true } });

  await prisma.$transaction(async (tx) => {
    await tx.serverSettings.upsert({
      where: { id: SERVER_ID },
      create: { id: SERVER_ID, allowHttp, accessReviewedAt: new Date() },
      update: { allowHttp, accessReviewedAt: new Date() },
    });
    if (turningOff) {
      await tx.session.deleteMany({
        where: currentSessionId ? { NOT: { id: currentSessionId } } : {},
      });
    }
    if (admin?.householdId) {
      await logActivity(
        {
          householdId: admin.householdId,
          actorId: adminId,
          verb: 'updated',
          subjectType: 'household',
          subjectId: admin.householdId,
          message: allowHttp
            ? 'allowed sign-in to the server over plain HTTP'
            : 'set sign-in to the server to HTTPS only',
        },
        tx,
      );
    }
  });

  cached = null;
  return getAccessSettings(headers);
}
