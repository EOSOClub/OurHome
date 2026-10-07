import { redirect } from 'next/navigation';
import { requireUser } from '@/server/auth/session';
import { MembersStep } from './members-step';

// Setup step 2: the new Head of House adds the people who live there. It is an
// ordinary signed-in page, so it can be reopened later; Members does the same.
export default async function SetupMembersPage() {
  const user = await requireUser();
  if (user.role !== 'head') redirect('/dashboard');

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <MembersStep />
    </main>
  );
}
