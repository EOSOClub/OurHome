import { redirect } from 'next/navigation';
import { getServerSession } from '@/server/auth/session';
import { ForcedPasswordChange } from '@/components/profile/forced-password-change';

// Standalone forced-password gate, deliberately outside the (app) layout so its
// own redirect (when mustChangePassword is set) can't loop back here.
export default async function ChangePasswordPage() {
  const session = await getServerSession();
  if (!session?.user) redirect('/login');

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <ForcedPasswordChange userName={session.user.name} />
    </main>
  );
}
