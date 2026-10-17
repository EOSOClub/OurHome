'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, UserPlus, Users } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { USER_ROLE_LABELS, type UserRole } from '@/lib/enums';
import type { HouseholdMemberDTO } from '@/lib/types';
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
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';
import { fieldProblem } from '@/lib/validation/messages';
import { emailSchema, passwordSchema, usernameSchema } from '@/lib/validation/user';
import { errorMessage } from '../setup-form';

// The Head of House can hand out any role but head (see canAssignRole).
const ROLES: UserRole[] = ['adult', 'manager', 'teen', 'child', 'guest'];

const EMPTY = { username: '', email: '', password: '', role: 'adult' as UserRole };

export function MembersStep() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [added, setAdded] = useState<HouseholdMemberDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fe = useFieldErrors('setup-member');

  // Checked as they type, by the server's own rules; the server's word wins.
  // The display name is sent as the username, so its problems show there too.
  const usernameError = fe.first('username', 'name') ?? fieldProblem(usernameSchema, form.username);
  const emailError = fe.get('email') ?? fieldProblem(emailSchema, form.email);
  const passwordError = fe.get('password') ?? fieldProblem(passwordSchema, form.password);
  const canSubmit =
    !!form.username.trim() && !usernameError && !emailError && !!form.password && !passwordError && !fe.has('role');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setLoading(true);
    try {
      const username = form.username.trim();
      const member = await apiFetch<HouseholdMemberDTO>('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          // The display name starts as the username; members can change it.
          name: username,
          username,
          email: form.email.trim() || undefined,
          role: form.role,
          password: form.password,
        }),
      });
      setAdded((list) => [...list, member]);
      setForm(EMPTY);
    } catch (err) {
      setError(errorMessage(err));
      fe.mark(err);
    } finally {
      setLoading(false);
    }
  }

  function finish() {
    router.push('/dashboard');
    router.refresh();
  }

  return (
    <Card className="w-full max-w-lg">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Users className="size-6" />
        </div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Setup · step 2 of 2
        </p>
        <CardTitle className="text-xl">Add your household</CardTitle>
        <CardDescription>
          Give each person a username and a starting password. They’ll choose
          their own password the first time they sign in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {added.length > 0 ? (
          <ul className="divide-y rounded-md border text-sm">
            {added.map((m) => (
              <li key={m.id} className="flex items-center justify-between px-3 py-2">
                <code>{m.username}</code>
                <span className="text-muted-foreground">
                  {USER_ROLE_LABELS[m.role as UserRole] ?? m.role}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" {...fe.formProps}>
          <div className="space-y-1.5" data-field="username name">
            <Label htmlFor="s-username">Username</Label>
            <Input
              id="s-username"
              autoCapitalize="none"
              spellCheck={false}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="e.g. jordan"
              aria-invalid={usernameError ? true : undefined}
              aria-describedby={fe.noteId('username')}
            />
            <FieldNote id={fe.noteId('username')} error={usernameError} />
          </div>
          <div className="space-y-1.5" data-field="password">
            <Label htmlFor="s-password">Starting password</Label>
            <Input
              id="s-password"
              autoComplete="off"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="8+ characters"
              aria-invalid={passwordError ? true : undefined}
              aria-describedby={fe.noteId('password')}
            />
            <FieldNote id={fe.noteId('password')} error={passwordError} />
          </div>
          <div className="space-y-1.5" data-field="email">
            <Label htmlFor="s-email">Email (optional)</Label>
            <Input
              id="s-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="for password recovery"
              aria-invalid={emailError ? true : undefined}
              aria-describedby={fe.noteId('email')}
            />
            <FieldNote id={fe.noteId('email')} error={emailError} />
          </div>
          <div className="space-y-1.5" data-field="role">
            <Label htmlFor="s-role">Role</Label>
            <Select
              id="s-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              {...fe.invalid('role')}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {USER_ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
            <FieldNote id={fe.noteId('role')} error={fe.get('role')} />
          </div>
          {error ? (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="outline"
            className="sm:col-span-2"
            disabled={loading || !canSubmit}
          >
            {loading ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Add person
          </Button>
        </form>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            You can add or change people later under Members.
          </p>
          <Button onClick={finish}>{added.length > 0 ? 'Finish' : 'Skip for now'}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
