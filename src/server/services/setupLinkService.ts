import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { prisma } from '@/server/db/prisma';
import { canBeSupervised } from '@/lib/permissions';
import type { SetupLinkDTO } from '@/lib/types';
import { logActivity } from '@/server/services/activityService';
import { getAppRelease } from '@/server/services/appDownloadService';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';
import { isHouseholdDisabled } from '@/server/services/serverAdminService';

// Guided child setup, phase 3: a setup link (shown as a QR code in Set up a
// child) opens a page on the child's phone that downloads the app without
// signing in, then opens it with their username filled in. One link per
// child, kept on their User row hashed with SHA-256, like the Home Assistant
// tokens. It ends after SETUP_LINK_HOURS, when a new one is made, or when
// they choose their own password (auth.ts). The token only reaches the app
// download and the child's name and username, never their account.

export const SETUP_LINK_HOURS = 24;
/** The page a setup link opens: /get-app/<token> (public, see proxy.ts). */
export const SETUP_LINK_PATH = '/get-app';

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Where the child's phone can reach this server: the address built into the
 * app, else the site's public address, else the one this request came in on.
 * Like the Install step, so a Head on a home-network address doesn't hand out
 * a link that only works at home.
 */
export function setupBaseUrl(requestUrl: string): string {
  const base = getAppRelease()?.server || process.env.BETTER_AUTH_URL?.trim() || new URL(requestUrl).origin;
  return base.replace(/\/+$/, '');
}

/** The QR code's modules, row by row ('1' dark), for both the website and the app to draw. */
export function qrRows(text: string): SetupLinkDTO['qr'] {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const rows: string[] = [];
  for (let y = 0; y < modules.size; y++) {
    let row = '';
    for (let x = 0; x < modules.size; x++) row += modules.get(y, x) ? '1' : '0';
    rows.push(row);
  }
  return { size: modules.size, rows };
}

/**
 * Makes a new setup link for [memberId] (a child or teen in the household),
 * replacing any earlier one. Head of House only (the route checks it).
 */
export async function createSetupLink(
  householdId: string,
  actor: { id: string },
  memberId: string,
  requestUrl: string,
  now: Date = new Date(),
): Promise<SetupLinkDTO> {
  const member = await prisma.user.findFirst({
    where: { id: memberId, householdId },
    select: { id: true, name: true, role: true },
  });
  if (!member) throw new NotFoundError('That member isn’t in your household.');
  if (!canBeSupervised(member.role)) {
    throw new ForbiddenError('Setup links are only for children and teens.', 'memberId');
  }

  const token = randomBytes(18).toString('base64url');
  const expiresAt = new Date(now.getTime() + SETUP_LINK_HOURS * 60 * 60 * 1000);
  await prisma.user.update({
    where: { id: member.id },
    data: { setupLinkHash: hashSetupToken(token), setupLinkExpiresAt: expiresAt },
  });
  await logActivity({
    householdId,
    actorId: actor.id,
    verb: 'created',
    subjectType: 'member',
    subjectId: member.id,
    message: `made a setup link for “${member.name}”’s phone`,
  });

  const url = `${setupBaseUrl(requestUrl)}${SETUP_LINK_PATH}/${token}`;
  return { url, expiresAt: expiresAt.toISOString(), qr: qrRows(url) };
}

export interface SetupLinkTarget {
  userId: string;
  name: string;
  /** As they type it to sign in. */
  username: string;
  householdName: string;
}

/** Who a setup link is for, or null when it's unknown, ended, or their household is turned off. */
export async function resolveSetupLink(token: string, now: Date = new Date()): Promise<SetupLinkTarget | null> {
  // A real token is 24 characters; anything else isn't worth a lookup.
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const user = await prisma.user.findFirst({
    where: { setupLinkHash: hashSetupToken(token) },
    select: {
      id: true,
      name: true,
      username: true,
      displayUsername: true,
      householdId: true,
      setupLinkExpiresAt: true,
      household: { select: { name: true } },
    },
  });
  if (!user?.householdId || !user.username || !user.household) return null;
  if (!user.setupLinkExpiresAt || user.setupLinkExpiresAt <= now) return null;
  if (await isHouseholdDisabled(user.householdId)) return null;
  return {
    userId: user.id,
    name: user.name,
    username: user.displayUsername ?? user.username,
    householdName: user.household.name,
  };
}

/**
 * The link the setup page's Open Our Home button follows: the app fills in
 * the username, and the server only when it has none (see the app's
 * SetupPrefill).
 */
export function appOpenLink(username: string, server: string): string {
  const q = new URLSearchParams({ username, server });
  return `ourhome://setup?${q.toString()}`;
}
