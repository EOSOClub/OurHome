import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from '@/server/auth/auth';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  householdId: string | null;
  mustChangePassword: boolean;
};

/** Reads the current session from cookies. Cached per request. */
export const getServerSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
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
    // A user without a household can't operate the app yet.
    redirect('/no-household');
  }
  return user;
}
