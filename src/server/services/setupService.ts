import { prisma } from '@/server/db/prisma';
import { ConflictError } from '@/server/services/errors';
import { createHouseholdWithHead } from '@/server/services/serverAdminService';
import { isHttpsRequest } from '@/server/security/network';
import type { SetupInput } from '@/lib/validation/setup';

// First-run setup: the first visitor to a fresh install creates the household
// and its Head of House (also the server admin), then adds members from
// the second setup step (which reuses the regular Members API).

// Once any account exists, setup is over for the life of the process.
let setupDone = false;

/** True until the first account exists. */
export async function needsSetup(): Promise<boolean> {
  if (setupDone) return false;
  setupDone = (await prisma.user.count()) > 0;
  return !setupDone;
}

/**
 * What a client trying to sign in to a fresh install is told: where to finish
 * setup, using the address it reached us at, and to try again after.
 */
export function setupRequiredMessage(headers: Headers, url?: string): string {
  const host = headers.get('host');
  const address = host
    ? `${isHttpsRequest(headers, url) ? 'https' : 'http'}://${host}`
    : 'this server’s address';
  return (
    `This server hasn’t been set up yet. Open ${address} in a web browser on ` +
    'your home network, create the admin account, then try again.'
  );
}

// Setup requests run one at a time, so two people racing the setup page can't
// both become Head of House (the app runs as a single server process).
let queue: Promise<unknown> = Promise.resolve();

export function completeSetup(input: SetupInput): Promise<{ username: string }> {
  const run = queue.then(() => runSetup(input));
  queue = run.catch(() => undefined);
  return run;
}

async function runSetup(input: SetupInput): Promise<{ username: string }> {
  if (!(await needsSetup())) {
    throw new ConflictError('Setup is already complete. Sign in instead.');
  }

  // The first account is the household's Head of House and the server admin
  // (who can add more households later, from the Server page).
  const { username } = await prisma.$transaction((tx) =>
    createHouseholdWithHead(tx, {
      householdName: input.householdName,
      head: { name: input.username, username: input.username, email: input.email, password: input.password },
      serverAdmin: true,
    }),
  );

  setupDone = true;
  return { username };
}
