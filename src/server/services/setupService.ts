import { prisma } from '@/server/db/prisma';
import { auth } from '@/server/auth/auth';
import { logActivity } from '@/server/services/activityService';
import { ConflictError } from '@/server/services/errors';
import { isHttpsRequest } from '@/server/security/network';
import type { SetupInput } from '@/lib/validation/setup';

// First-run setup replaces the old seed script: the first visitor to a fresh
// install creates the household and its Head of House, then adds members from
// the second setup step (which reuses the regular Members API).

/** Starter categories, so the task, shopping and inventory pickers aren't empty. */
const DEFAULT_CATEGORIES = [
  { name: 'Cleaning', kind: 'task', color: '#38bdf8' },
  { name: 'Pets', kind: 'task', color: '#f472b6' },
  { name: 'Maintenance', kind: 'task', color: '#fbbf24' },
  { name: 'Yard', kind: 'task', color: '#34d399' },
  { name: 'Grocery', kind: 'shopping', color: '#a78bfa' },
  { name: 'Supplies', kind: 'shopping', color: '#f87171' },
  { name: 'Pantry', kind: 'inventory', color: '#fb923c' },
];

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

  const displayUsername = input.username.trim();
  const username = displayUsername.toLowerCase();
  const email = (input.email?.trim() || `${username}@household.local`).toLowerCase();

  const authCtx = await auth.$context;
  const hashed = await authCtx.password.hash(input.password);

  await prisma.$transaction(async (tx) => {
    const household = await tx.household.create({
      data: { name: input.householdName.trim() },
    });
    await tx.category.createMany({
      data: DEFAULT_CATEGORIES.map((c) => ({ ...c, householdId: household.id })),
    });
    const head = await tx.user.create({
      data: {
        name: displayUsername,
        email,
        emailVerified: false,
        username,
        displayUsername,
        role: 'head',
        householdId: household.id,
      },
    });
    await tx.account.create({
      data: {
        accountId: head.id,
        providerId: 'credential',
        userId: head.id,
        password: hashed,
      },
    });
    await logActivity(
      {
        householdId: household.id,
        actorId: head.id,
        verb: 'created',
        subjectType: 'household',
        subjectId: household.id,
        message: `set up the household “${household.name}”`,
      },
      tx,
    );
  });

  setupDone = true;
  return { username };
}
