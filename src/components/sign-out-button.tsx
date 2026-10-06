'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';

export function SignOutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onClick() {
    setLoading(true);
    await signOut();
    router.push('/login');
    router.refresh();
  }

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
