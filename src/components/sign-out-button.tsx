'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

/** Signs out and returns to the login page; shared with the user menu. */
export function useSignOut() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    await signOut();
    router.push('/login');
    router.refresh();
  }

  return { signOut: run, loading };
}

export function SignOutButton() {
  const { signOut: onClick, loading } = useSignOut();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={loading}
      aria-label="Sign out"
    >
      {loading ? <Loader2 className="animate-spin" /> : <LogOut />}
    </Button>
  );
}
