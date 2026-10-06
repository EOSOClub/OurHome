'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2, LogOut } from 'lucide-react';
import { changePassword, signOut } from '@/lib/auth-client';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ForcedPasswordChange({ userName }: { userName: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const canSubmit =
    current.length > 0 && next.length >= 8 && confirm.length > 0 && !loading;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setLoading(true);
    const { error } = await changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    if (error) {
      setLoading(false);
      setError(error.message || 'Could not set your password.');
      return;
    }
    try {
      await apiFetch('/api/profile/clear-password-flag', { method: 'POST' });
    } catch {
      // Non-fatal: the gate re-checks the DB, worst case they retry.
    }
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <KeyRound className="size-6" />
        </div>
        <CardTitle className="text-xl">Choose your password</CardTitle>
        <CardDescription>
          Welcome, {userName}. You signed in with a temporary password — set your
          own to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="temp-password">Temporary password</Label>
            <Input
              id="temp-password"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="at least 8 characters"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            Set password & continue
          </Button>
        </form>
        <button
          type="button"
          onClick={async () => {
            await signOut();
            router.push('/login');
          }}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <LogOut className="size-3.5" /> Sign out
        </button>
      </CardContent>
    </Card>
  );
}
