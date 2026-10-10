import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/server/auth/auth';
import { isRefusedPlainHttp } from '@/server/services/accessService';
import { isFeatureEnabled, isHouseholdDisabled, isServerAdmin } from '@/server/services/serverAdminService';
import type { Feature } from '@/lib/features';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  householdId: string | null;
  mustChangePassword: boolean;
};

/**
 * Reads the current session from cookies. Cached per request. Under "HTTPS
 * only" (accessService) a plain-HTTP request from another device has no
 * session, so pages fall back to the login screen and the API answers 401.
 */
export const getServerSession = cache(async () => {
  const h = await headers();
  if (await isRefusedPlainHttp(h)) return null;
  // Read the session and user from the database, not Better Auth's signed
  // cookie cache: that copy is up to 5 minutes old, so a demoted manager kept
  // their powers, and a removed member (sessions deleted) kept access, until
  // it expired. Permission checks must see the live role and session.
  return auth.api.getSession({ headers: h, query: { disableCookieCache: true } });
});

/**
 * Require an authenticated user that belongs to a household. Redirects to the
 * login page (or onboarding) when those conditions aren't met. Use in Server
 * Components and Server Actions that need a guaranteed user + household.
 */
export async function requireUser(): Promise<AuthUser> {
  const session = await getServerSession();
  if (!session?.user) {
    redirect('/login');
  }
  const user = session.user as unknown as AuthUser;
  if (!user.householdId) {
    // A server admin may have no household: their page is /server. Anyone
    // else without one can't operate the app yet.
    redirect((await isServerAdmin(user.id)) ? '/server' : '/no-household');
  }
  if (await isHouseholdDisabled(user.householdId)) {
    redirect('/no-household?disabled=1');
  }
  return user;
}

/**
 * requireUser for a feature's page: when the server admin turned the feature
 * off for this household (an old link or bookmark), go to the dashboard.
 */
export async function requireFeature(feature: Feature): Promise<AuthUser> {
  const user = await requireUser();
  if (!(await isFeatureEnabled(user.householdId!, feature))) redirect('/dashboard');
  return user;
}
