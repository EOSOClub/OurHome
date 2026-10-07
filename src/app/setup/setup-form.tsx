'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Home, Loader2 } from 'lucide-react';
import { signIn } from '@/lib/auth-client';
import { apiFetch, ApiError } from '@/lib/api';
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

/** The first field error from a 422, or the error's own message. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = (err.details as { fieldErrors?: Record<string, string[]> })?.fieldErrors;
    const [field, messages] = Object.entries(fields ?? {})[0] ?? [];
    if (field && messages?.[0]) return `${field}: ${messages[0]}`;
    return err.message;
  }
  return 'Something went wrong. Try again.';
}

export function SetupForm({ appName, local }: { appName: string; local: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({
    householdName: 'Our Home',
    username: '',
    email: '',
    password: '',
    confirm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;
  const canSubmit =
    form.householdName.trim() &&
    form.username.trim().length >= 3 &&
    form.password.length >= 8 &&
    form.password === form.confirm;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch('/api/setup', {
        method: 'POST',
        body: JSON.stringify({
          householdName: form.householdName.trim(),
          username: form.username.trim(),
          email: form.email.trim() || undefined,
          password: form.password,
        }),
      });
    } catch (err) {
      setLoading(false);
      setError(errorMessage(err));
      return;
    }

    const { error } = await signIn.username({
      username: form.username.trim(),
      password: form.password,
    });
    if (error) {
      // The account exists; only the automatic sign-in failed.
      router.push('/login?redirect=/setup/members');
      return;
    }
    router.push('/setup/members');
    router.refresh();
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Home className="size-6" />
        </div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Setup · step 1 of 2
        </p>
        <CardTitle className="text-xl">Welcome to {appName}</CardTitle>
        <CardDescription>
          Create the admin account. It becomes the Head of House and can add
          everyone else.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!local ? (
          <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            Setup only works from a device on your home network. Open this site
            by the server’s local address, for example{' '}
            <code className="rounded bg-background px-1">http://192.168.1.20:3000</code>.
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="household">Household name</Label>
            <Input
              id="household"
              required
              value={form.householdName}
              onChange={(e) => setForm({ ...form, householdName: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="username">Admin username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="e.g. alex"
            />
            <p className="text-xs text-muted-foreground">
              At least 3 characters: letters, numbers, . _ -
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email (optional)</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="for password recovery"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              required
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
            {mismatch ? (
              <p className="text-xs text-destructive">Passwords don’t match.</p>
            ) : null}
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={loading || !canSubmit}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            Create admin account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
