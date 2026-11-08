'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

/** Signs out and returns to the login page; shared with the user menu. */
export function useSignOut() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    // A failed sign-out used to leave the spinner turning forever. The auth
    // client reports a server refusal as `error` and a network failure by
    // throwing; both stop the spinner and say so.
    let failed = false;
    try {
      const result = await signOut();
      failed = !!result?.error;
    } catch {
      failed = true;
    }
    if (failed) {
      setLoading(false);
      toast.error("Couldn't sign out. Check your connection and try again.");
      return;
    }
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
