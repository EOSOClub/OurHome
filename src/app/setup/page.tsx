import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { APP_NAME } from '@/server/config';
import { isFromLocalNetwork } from '@/server/security/network';
import { needsSetup } from '@/server/services/setupService';
import { SetupForm } from './setup-form';

export default async function SetupPage() {
  if (!(await needsSetup())) redirect('/login');
  const local = isFromLocalNetwork(await headers());

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <SetupForm appName={APP_NAME} local={local} />
    </main>
  );
}
