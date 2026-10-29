'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Home, Loader2 } from 'lucide-react';
import { signIn } from '@/lib/auth-client';
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

export function LoginForm({ appName }: { appName: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get('redirect') || '/dashboard';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Which fields the refusal is about (Better Auth names none; its code says).
  const [bad, setBad] = useState<{ username?: boolean; password?: boolean }>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBad({});
    setLoading(true);
    // Better Auth validates the characters before normalising, so a stray
    // space (autofill, phone keyboards) fails as "Invalid username".
    const { error } = await signIn.username({ username: username.trim(), password });
    setLoading(false);
    if (error) {
      const code = error.code ?? '';
      if (code === 'INVALID_USERNAME') {
        setError('That isn’t a valid username: use only letters, numbers and . _ - (no spaces).');
        setBad({ username: true });
      } else if (code === 'USERNAME_TOO_SHORT' || code === 'USERNAME_TOO_LONG') {
        setError('Usernames are 3 to 30 characters long.');
        setBad({ username: true });
      } else if (error.status === 429) {
        setError('Too many attempts. Wait a few seconds and try again.');
      } else {
        // Wrong username or password: both are marked, so it doesn't say which.
        setError(error.message || 'Invalid username or password.');
        if (error.status === 401) setBad({ username: true, password: true });
      }
      return;
    }
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Home className="size-6" />
        </div>
        <CardTitle className="text-xl">{appName}</CardTitle>
        <CardDescription>Sign in to your household</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setBad((b) => ({ ...b, username: false }));
              }}
              placeholder="username"
              aria-invalid={bad.username || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setBad((b) => ({ ...b, password: false }));
              }}
              aria-invalid={bad.password || undefined}
              aria-describedby={error ? 'login-error' : undefined}
            />
          </div>
          {error ? (
            <p id="login-error" className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
