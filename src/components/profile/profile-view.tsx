'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import {
  CheckCircle2,
  ClipboardList,
  KeyRound,
  Loader2,
  ShoppingBag,
  UserRound,
} from 'lucide-react';
import type { HouseholdProfile, ProfileOverview } from '@/server/services/profileService';
import { AboutMeCard } from '@/components/profile/about-me-card';
import { HouseholdCard } from '@/components/profile/household-card';
import { ProfileAvatar } from '@/components/profile/profile-avatar';
import type { AppRelease } from '@/server/services/appDownloadService';
import { AndroidAppCard } from '@/components/profile/android-app-card';
import { LocationCard } from '@/components/profile/location-card';
import { AppUsageNotice } from '@/components/profile/app-usage-notice';
import { useHouseholdFeatures } from '@/components/household-features';
import type { LocationConsent } from '@/lib/location';
import { changePassword, updateUser } from '@/lib/auth-client';
import { apiFetch, ApiError } from '@/lib/api';
import { passwordChangeError } from '@/lib/auth-errors';
import { useFieldErrors } from '@/lib/use-field-errors';
import { fieldProblem } from '@/lib/validation/messages';
import { emailSchema, usernameSchema } from '@/lib/validation/user';
import { FieldNote } from '@/components/ui/field-note';
import { USER_ROLE_LABELS, type UserRole } from '@/lib/enums';
import { StatCard } from '@/components/dashboard/stat-card';
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
import { toast } from '@/components/ui/toast';
import { useHouseholdZone } from '@/components/household-zone';

const STAT_LINK_CLASS =
  'block rounded-lg transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function ProfileView({
  overview,
  household,
  location,
  appRelease,
}: {
  overview: ProfileOverview;
  /** Everyone's about-me fields (the household directory). */
  household: HouseholdProfile[];
  /** The member's own location consent. */
  location: LocationConsent;
  /** The Android app built on this server, if any. */
  appRelease: AppRelease | null;
}) {
  // Location sharing is hidden with the Location feature.
  const features = useHouseholdFeatures();
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ProfileAvatar
          name={overview.name}
          emoji={overview.profile.avatarEmoji}
          color={overview.profile.profileColor}
          size="lg"
        />
        <div>
          <h1 className="text-2xl font-semibold">Profile</h1>
          <p className="text-sm text-muted-foreground">
            Your about-me, account details and password.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Link href="/tasks" className={STAT_LINK_CLASS}>
          <StatCard
            label="Tasks completed"
            value={overview.stats.tasksCompleted}
            icon={CheckCircle2}
            tone="success"
          />
        </Link>
        <Link href="/tasks" className={STAT_LINK_CLASS}>
          <StatCard
            label="Open assigned tasks"
            value={overview.stats.openAssignedTasks}
            icon={ClipboardList}
          />
        </Link>
        <Link href="/shopping" className={STAT_LINK_CLASS}>
          <StatCard
            label="Purchases logged"
            value={overview.stats.purchasesLogged}
            icon={ShoppingBag}
          />
        </Link>
      </div>

      <AboutMeCard overview={overview} />
      {household.length > 1 ? <HouseholdCard members={household} userId={overview.id} /> : null}
      <OverviewCard overview={overview} />
      {features.includes('location') ? <LocationCard initial={location} /> : null}
      <AppUsageNotice />
      {appRelease && <AndroidAppCard release={appRelease} />}
      <EditProfileCard overview={overview} />
      <ChangePasswordCard />
    </div>
  );
}

function OverviewCard({ overview }: { overview: ProfileOverview }) {
  const timeZone = useHouseholdZone();
  const rows: { label: string; value: string }[] = [
    { label: 'Email', value: overview.email },
    {
      label: 'Username',
      value: overview.username ?? '-',
    },
    {
      label: 'Role',
      value: USER_ROLE_LABELS[overview.role as UserRole] ?? overview.role,
    },
    { label: 'Household', value: overview.householdName ?? '-' },
    {
      label: 'Member since',
      value: new Date(overview.memberSince).toLocaleDateString(undefined, {
        timeZone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4" /> Account
        </CardTitle>
        <CardDescription>Your account details at a glance.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3 px-3 py-2.5"
            >
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="truncate text-sm font-medium">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function EditProfileCard({ overview }: { overview: ProfileOverview }) {
  const router = useRouter();
  const [name, setName] = useState(overview.name);
  const [username, setUsername] = useState(overview.username ?? '');
  const [email, setEmail] = useState(overview.email);
  // Changing the email (where password resets go) needs the password.
  const [emailPassword, setEmailPassword] = useState('');

  const dirtyName = name.trim() !== overview.name;
  const dirtyUsername = username.trim() !== (overview.username ?? '');
  const dirtyEmail = email.trim() !== overview.email;
  const dirty = dirtyName || dirtyUsername || dirtyEmail;
  const fe = useFieldErrors('profile');
  // Checked as they type, by the server's own rules; the server's word wins.
  const usernameError = fe.get('username') ?? fieldProblem(usernameSchema, username);
  const emailError = fe.get('email') ?? fieldProblem(emailSchema, email);
  const nameError = fe.get('name') ?? (name.trim() ? null : 'Enter a name.');

  const save = useMutation({
    mutationFn: async () => {
      // Name goes through Better Auth so the session (and header) stay in sync;
      // username/email go through our profile API (uniqueness-checked).
      if (dirtyName) {
        const { error } = await updateUser({ name: name.trim() });
        if (error) {
          const message = error.message || 'Could not update your name.';
          // Better Auth names no field: this one is about the name.
          throw new ApiError(message, error.status ?? 400, { fieldErrors: { name: [message] } });
        }
      }
      if (dirtyUsername || dirtyEmail) {
        await apiFetch('/api/profile', {
          method: 'PATCH',
          body: JSON.stringify({
            username: dirtyUsername ? username.trim() : undefined,
            email: dirtyEmail ? email.trim() : undefined,
            currentPassword: dirtyEmail ? emailPassword : undefined,
          }),
        });
      }
    },
    onSuccess: () => {
      toast.success('Profile updated');
      setEmailPassword('');
      router.refresh();
    },
    // Says why and marks the field (a taken username, a wrong current password).
    onError: fe.fail,
  });

  const canSubmit =
    dirty &&
    !nameError &&
    !!username.trim() &&
    !usernameError &&
    !!email.trim() &&
    !emailError &&
    (!dirtyEmail || emailPassword.length > 0) &&
    !save.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4" /> Edit profile
        </CardTitle>
        <CardDescription>
          Update your display name, username, and recovery email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) save.mutate();
          }}
          className="space-y-4"
          {...fe.formProps}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5" data-field="name">
              <Label htmlFor="profile-name">Display name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={fe.noteId('name')}
              />
              <FieldNote id={fe.noteId('name')} error={nameError} />
            </div>
            <div className="space-y-1.5" data-field="username">
              <Label htmlFor="profile-username">Username</Label>
              <Input
                id="profile-username"
                value={username}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                aria-invalid={usernameError ? true : undefined}
                aria-describedby={fe.noteId('username')}
              />
              <FieldNote id={fe.noteId('username')} error={usernameError} />
            </div>
            <div className="space-y-1.5 sm:col-span-2" data-field="email">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                aria-invalid={emailError ? true : undefined}
                aria-describedby={fe.noteId('email')}
              />
              <FieldNote id={fe.noteId('email')} error={emailError} />
            </div>
            {dirtyEmail ? (
              <div className="space-y-1.5 sm:col-span-2" data-field="currentPassword">
                <Label htmlFor="profile-email-password">Current password</Label>
                <Input
                  id="profile-email-password"
                  type="password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  autoComplete="current-password"
                  {...fe.invalid('currentPassword')}
                />
                <FieldNote
                  id={fe.noteId('currentPassword')}
                  error={fe.get('currentPassword')}
                  hint="Needed to change your email, since password resets go there."
                />
              </div>
            ) : null}
          </div>
          <Button type="submit" disabled={!canSubmit}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save changes
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const fe = useFieldErrors('password');

  const change = useMutation({
    mutationFn: async () => {
      const { error } = await changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      });
      if (error) throw passwordChangeError(error, 'Could not change your password.');
      // Lift the temp-password gate if it was set.
      try {
        await apiFetch('/api/profile/clear-password-flag', { method: 'POST' });
      } catch {
        // Non-fatal.
      }
    },
    onSuccess: () => {
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
    },
    // Says why and marks the field (a wrong current password, a refused new one).
    onError: fe.fail,
  });

  const nextTooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    current.length > 0 &&
    next.length >= 8 &&
    confirm === next &&
    !change.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Change password
        </CardTitle>
        <CardDescription>
          Enter your current password, then choose a new one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) change.mutate();
          }}
          className="space-y-4"
          {...fe.formProps}
        >
          <div className="space-y-1.5" data-field="currentPassword">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              {...fe.invalid('currentPassword')}
            />
            <FieldNote id={fe.noteId('currentPassword')} error={fe.get('currentPassword')} />
          </div>
          <div className="space-y-1.5" data-field="newPassword">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              aria-invalid={nextTooShort || fe.has('newPassword') || undefined}
              aria-describedby="new-password-hint"
              onChange={(e) => setNext(e.target.value)}
            />
            <FieldNote
              id="new-password-hint"
              error={fe.get('newPassword') ?? (nextTooShort ? 'At least 8 characters.' : null)}
              hint="At least 8 characters."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
            />
            {mismatch ? (
              <p className="text-xs text-destructive" role="alert">
                Passwords do not match.
              </p>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border-input"
              checked={revokeOthers}
              onChange={(e) => setRevokeOthers(e.target.checked)}
            />
            Sign out of other devices
          </label>
          <Button type="submit" disabled={!canSubmit}>
            {change.isPending ? <Loader2 className="animate-spin" /> : null}
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
