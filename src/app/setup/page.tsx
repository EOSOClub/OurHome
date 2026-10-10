import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { APP_NAME } from '@/server/config';
import { isFromLocalNetwork } from '@/server/security/network';
import { needsSetup } from '@/server/services/setupService';
import { SetupForm } from './setup-form';

export default async function SetupPage() {
  // Per request: setup state lives in the database, which the build can't
  // (and shouldn't) reach while prerendering.
  await connection();
  if (!(await needsSetup())) redirect('/login');
  const local = isFromLocalNetwork(await headers());

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <SetupForm appName={APP_NAME} local={local} />
    </main>
  );
}
