'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Baby, Check, Copy, Loader2, PartyPopper, RefreshCw } from 'lucide-react';
import type { HouseholdMemberDTO, LookAfterDTO, SetupLinkDTO, SupervisionDTO } from '@/lib/types';
import { USER_ROLE_LABELS } from '@/lib/enums';
import { PHONE_RULES, PHONE_RULE_LABELS, type PhoneRules } from '@/lib/phoneHealth';
import { apiFetch, fieldErrors } from '@/lib/api';
import { fieldProblem } from '@/lib/validation/messages';
import { emailSchema, passwordSchema, usernameSchema } from '@/lib/validation/user';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldNote } from '@/components/ui/field-note';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { SUPERVISION_HINT, SupervisorChecks, toggled } from '@/components/members/supervisors';
import { LOOK_AFTER_KEY } from '@/components/look-after/look-after-view';
import { SetupSteps, setupComplete } from '@/components/look-after/setup-progress';
import { QrCode } from '@/components/members/qr-code';

// Set up a child (guided child setup, phase 2): the Head of House adds a child
// or teen, chooses who supervises them and, when the Head is one of them, what
// their phone must do; then gets the steps for installing the app on the
// child's phone (with a setup link, shown as a QR code, when the server has
// built the app), and watches that phone tick off Set up this phone. Nothing is
// made until the third step's button. The choices are a supervisor's (the
// server refuses them otherwise), so a Head who doesn't supervise them skips
// that step and leaves the defaults to the supervisors.

type Step = 'account' | 'supervisors' | 'phone' | 'install' | 'progress';
const STEPS: { key: Step; label: string }[] = [
  { key: 'account', label: 'Account' },
  { key: 'supervisors', label: 'Supervisors' },
  { key: 'phone', label: 'Their phone' },
  { key: 'install', label: 'Install' },
  { key: 'progress', label: 'Progress' },
];

/** While open on the last step: their phone checks in after each step, so look often. */
const PROGRESS_REFETCH_MS = 5_000;

type KidRole = 'child' | 'teen';

/** The member just made (or the one this page was reopened for). */
type Made = { id: string; name: string; username: string; password: string | null; supervisorIds: string[] };

/** A readable, copy-pasteable temporary password (>= 8 chars, alphanumeric), as on Members. */
function generatePassword(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return raw.slice(0, 12);
}

const noSubscribe = () => () => {};
/** This site's address, as the child's phone should open it; empty while rendering on the server. */
function useOrigin(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.origin, () => '');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!text}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy to the clipboard.');
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function StepBar({ current }: { current: Step }) {
  const at = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          aria-current={i === at ? 'step' : undefined}
          className={i === at ? 'font-semibold text-foreground' : i < at ? 'text-muted-foreground' : 'text-muted-foreground/70'}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

const DEFAULT_RULES: PhoneRules = { keepRunning: true, preventUninstall: true, batteryUnrestricted: true };

export function AddChildWizard({
  actorId,
  supervision,
  locationOn,
  app,
  resume,
}: {
  actorId: string;
  supervision: SupervisionDTO;
  /** The household uses Location: "Location required" and People you look after exist. */
  locationOn: boolean;
  /** The Android app this server built; null: none yet. server: the address built in ('' = asked at sign-in). */
  app: { server: string } | null;
  /** Reopened for a child already added (?member=): straight to Install. */
  resume: Made | null;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(resume ? 'install' : 'account');
  const [made, setMade] = useState<Made | null>(resume);
  const blank = () => ({
    name: '',
    username: '',
    email: '',
    role: 'child' as KidRole,
    // Empty at first: a generated one would differ between the server's render and the browser's.
    password: '',
    supervisorIds: [actorId].filter((id) => supervision.supervisors.some((s) => s.id === id)),
    locationRequired: false,
    shareAppUsage: false,
    rules: DEFAULT_RULES,
  });
  const [form, setForm] = useState(blank);
  // What the server said was wrong with each field, until that field is edited.
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const edit = (patch: Partial<ReturnType<typeof blank>>) => {
    setForm({ ...form, ...patch });
    setServerErrors((errs) => {
      const next = { ...errs };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const errors = {
    name: serverErrors.name ?? null,
    username: serverErrors.username ?? fieldProblem(usernameSchema, form.username),
    email: serverErrors.email ?? fieldProblem(emailSchema, form.email),
    role: serverErrors.role ?? null,
    password: serverErrors.password ?? fieldProblem(passwordSchema, form.password),
  };
  const accountReady =
    !!form.name.trim() && !!form.username.trim() && !!form.password && !Object.values(errors).some(Boolean);
  // Their phone choices are a supervisor's to make.
  const choosing = form.supervisorIds.includes(actorId);
  const kidName = form.name.trim() || 'them';

  const create = useMutation({
    mutationFn: () =>
      apiFetch<HouseholdMemberDTO>('/api/members', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          username: form.username.trim(),
          email: form.email.trim() || undefined,
          role: form.role,
          password: form.password,
          supervisorIds: form.supervisorIds,
          setup: choosing
            ? {
                locationRequired: locationOn && form.locationRequired,
                shareAppUsage: form.shareAppUsage,
                rules: form.rules,
              }
            : undefined,
        }),
      }),
    onSuccess: (member) => {
      setMade({
        id: member.id,
        name: member.name,
        username: member.username ?? form.username.trim(),
        password: form.password,
        supervisorIds: form.supervisorIds,
      });
      setStep('install');
      // A reload from here comes back to Install for them, not a blank form.
      window.history.replaceState(null, '', `?member=${member.id}`);
      queryClient.invalidateQueries({ queryKey: ['members'] });
      queryClient.invalidateQueries({ queryKey: LOOK_AFTER_KEY });
    },
    onError: (err) => {
      const fields = fieldErrors(err);
      setServerErrors(fields);
      // Back to the step with the field the server named.
      if (fields.supervisorIds) setStep('supervisors');
      else if (fields.setup) setStep('phone');
      else if (Object.keys(fields).length) setStep('account');
      toast.error(err instanceof Error ? err.message : 'Could not add them.');
    },
  });

  const startOver = () => {
    setForm(blank());
    setServerErrors({});
    setMade(null);
    setStep('account');
    window.history.replaceState(null, '', window.location.pathname);
  };

  const supervisorNames = (ids: string[]) =>
    supervision.supervisors.filter((s) => ids.includes(s.id)).map((s) => s.name);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/members" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Members
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Baby className="size-6" /> Set up a child
        </h1>
        <p className="text-sm text-muted-foreground">
          Add a child or teen, choose who looks after them, then set up the OurHome app on their phone. Nothing is
          added until step 3.
        </p>
        <StepBar current={step} />
      </div>

      <Card className="max-w-2xl">
        {step === 'account' ? (
          <>
            <CardHeader>
              <CardTitle>Their account</CardTitle>
              <CardDescription>
                They sign in with this username and the temporary password, then choose their own.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (accountReady) setStep('supervisors');
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="c-name">Name</Label>
                  <Input
                    id="c-name"
                    value={form.name}
                    aria-invalid={!!errors.name}
                    aria-describedby="c-name-hint"
                    onChange={(e) => edit({ name: e.target.value })}
                    placeholder="e.g. Mia"
                  />
                  <FieldNote id="c-name-hint" error={errors.name} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-username">Username</Label>
                  <Input
                    id="c-username"
                    value={form.username}
                    aria-invalid={!!errors.username}
                    aria-describedby="c-username-hint"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => edit({ username: e.target.value })}
                    placeholder="e.g. mia"
                  />
                  <FieldNote
                    id="c-username-hint"
                    error={errors.username}
                    hint="3 to 30 letters, numbers or . _ - (no spaces)."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-email">Email (optional)</Label>
                  <Input
                    id="c-email"
                    type="email"
                    value={form.email}
                    aria-invalid={!!errors.email}
                    aria-describedby="c-email-hint"
                    onChange={(e) => edit({ email: e.target.value })}
                    placeholder="for password recovery"
                  />
                  <FieldNote id="c-email-hint" error={errors.email} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="c-role">Role</Label>
                  <Select
                    id="c-role"
                    value={form.role}
                    aria-invalid={!!errors.role}
                    aria-describedby="c-role-hint"
                    onChange={(e) => edit({ role: e.target.value as KidRole })}
                  >
                    <option value="child">{USER_ROLE_LABELS.child}</option>
                    <option value="teen">{USER_ROLE_LABELS.teen}</option>
                  </Select>
                  <FieldNote id="c-role-hint" error={errors.role} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="c-password">Temporary password</Label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="c-password"
                      className="max-w-xs"
                      value={form.password}
                      aria-invalid={!!errors.password}
                      aria-describedby="c-password-hint"
                      onChange={(e) => edit({ password: e.target.value })}
                      placeholder="at least 8 characters"
                    />
                    <Button type="button" variant="outline" onClick={() => edit({ password: generatePassword() })}>
                      <RefreshCw className="size-4" /> Generate
                    </Button>
                  </div>
                  <FieldNote
                    id="c-password-hint"
                    error={errors.password}
                    hint="At least 8 characters. You'll see it again on the Install step."
                  />
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={!accountReady}>
                    Next <ArrowRight />
                  </Button>
                </div>
              </form>
            </CardContent>
          </>
        ) : null}

        {step === 'supervisors' ? (
          <>
            <CardHeader>
              <CardTitle>Who supervises {kidName}</CardTitle>
              <CardDescription>{SUPERVISION_HINT}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <SupervisorChecks
                supervisors={supervision.supervisors}
                checked={form.supervisorIds}
                kidName={kidName}
                onToggle={(id) => edit({ supervisorIds: toggled(form.supervisorIds, id) })}
              />
              <FieldNote
                id="c-supervisors-hint"
                error={serverErrors.supervisorIds}
                hint={
                  form.supervisorIds.length === 0
                    ? 'Tick at least one: their phone is only set up for the adults who look after them.'
                    : choosing
                      ? undefined
                      : 'You haven’t ticked yourself, so their supervisors choose what their phone must do.'
                }
              />
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setStep('account')}>
                  <ArrowLeft /> Back
                </Button>
                <Button disabled={form.supervisorIds.length === 0} onClick={() => setStep('phone')}>
                  Next <ArrowRight />
                </Button>
              </div>
            </CardContent>
          </>
        ) : null}

        {step === 'phone' ? (
          <>
            <CardHeader>
              <CardTitle>What {kidName}’s phone must do</CardTitle>
              <CardDescription>
                Each one ticked is a step in Set up this phone in the app on their phone, and you’re told if it gets
                turned off later. You can change these any time on People you look after.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {choosing ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    Their phone always has to allow notifications, so alerts reach them and a ring can be stopped.
                  </p>
                  {locationOn ? (
                    <Choice
                      checked={form.locationRequired}
                      onChange={(v) => edit({ locationRequired: v })}
                      label="Location required"
                      hint="Their location sharing stays on, and you can check where they are on the Map without them allowing it. They always see when you check."
                    />
                  ) : null}
                  <Choice
                    checked={form.shareAppUsage}
                    onChange={(v) => edit({ shareAppUsage: v })}
                    label="Share app usage"
                    hint="Shows their supervisors how long they spend in each app. Their phone needs Usage access for it."
                  />
                  {PHONE_RULES.map((rule) => (
                    <Choice
                      key={rule}
                      checked={form.rules[rule]}
                      onChange={(v) => edit({ rules: { ...form.rules, [rule]: v } })}
                      label={`Require ${PHONE_RULE_LABELS[rule]}`}
                      hint={RULE_HINTS[rule]}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Only the adults who supervise {kidName} choose these, and you haven’t ticked yourself. Until{' '}
                  {supervisorNames(form.supervisorIds).join(' or ')} changes them on People you look after, their
                  phone must allow notifications, unrestricted battery, Prevent uninstall and Keep Our Home running.
                  Their location sharing stays their own choice, and their app usage isn’t shared.
                </p>
              )}
              <FieldNote id="c-setup-hint" error={serverErrors.setup} />
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" disabled={create.isPending} onClick={() => setStep('supervisors')}>
                  <ArrowLeft /> Back
                </Button>
                <Button disabled={create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? <Loader2 className="animate-spin" /> : <Check />}
                  Add {kidName}
                </Button>
              </div>
            </CardContent>
          </>
        ) : null}

        {step === 'install' && made ? (
          <InstallStep
            made={made}
            app={app}
            watching={made.supervisorIds.includes(actorId)}
            supervisorNames={supervisorNames(made.supervisorIds)}
            locationOn={locationOn}
            onNext={() => setStep('progress')}
            onAnother={startOver}
          />
        ) : null}

        {step === 'progress' && made ? (
          <ProgressStep made={made} locationOn={locationOn} onBack={() => setStep('install')} onAnother={startOver} />
        ) : null}
      </Card>
    </div>
  );
}

const RULE_HINTS: Record<keyof PhoneRules, string> = {
  keepRunning: 'Stops OurHome being closed on their phone.',
  preventUninstall: 'Stops OurHome being removed without the parent PIN. A parent sets the PIN on their phone.',
  batteryUnrestricted: 'Stops battery saving from holding back rings and alerts.',
};

function Choice({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 rounded border-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function InstallStep({
  made,
  app,
  watching,
  supervisorNames,
  locationOn,
  onNext,
  onAnother,
}: {
  made: Made;
  app: { server: string } | null;
  /** The viewer supervises them, so can watch their phone on the next step. */
  watching: boolean;
  supervisorNames: string[];
  locationOn: boolean;
  onNext: () => void;
  onAnother: () => void;
}) {
  const origin = useOrigin();
  // The address built into the app is the one their phone can always reach; the
  // address this page is open on may only work at home (a local address).
  const address = app?.server || origin;
  return (
    <>
      <CardHeader>
        <CardTitle>Put OurHome on {made.name}’s phone</CardTitle>
        <CardDescription>
          {made.name} is added. Do these on their phone, with them, because a parent sets the PIN in the last part.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {app ? (
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              On their phone, scan this code with the camera, or open the link.
              <SetupLinkBox memberId={made.id} name={made.name} />
            </li>
            <li>
              Tap <strong>Download for Android</strong> on the page that opens, then open the downloaded file to install
              it. Android asks once to allow installs from the browser.
            </li>
            <li>
              Back on that page, tap <strong>Open Our Home</strong>: their username,{' '}
              <code className="rounded bg-muted px-1">{made.username}</code>, is filled in. They sign in with the
              temporary password and choose their own straight away.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {made.password ? (
                  <>
                    <code className="rounded bg-muted px-1">{made.password}</code>
                    <CopyButton text={made.password} label="Copy temporary password" />
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    The temporary password is the one you set. Forgotten it? Set a new one on their row on Members.
                  </span>
                )}
              </div>
            </li>
            <li>
              <strong>Set up this phone</strong> opens by itself. Do each step on their phone. For{' '}
              <strong>Prevent uninstall</strong> you choose the parent PIN, so keep it to yourself.
            </li>
          </ol>
        ) : null}
        {app ? (
          <p className="text-xs text-muted-foreground">
            No camera? Open <code className="rounded bg-muted px-1">{address || 'this site'}</code> in the browser on
            their phone, sign in as <code className="rounded bg-muted px-1">{made.username}</code>, and tap{' '}
            <strong>Download for Android</strong> on their Profile.
          </p>
        ) : null}
        {app ? null : (
          // No app built on this server: no setup link either (nothing to download).
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              Open <code className="rounded bg-muted px-1">{address || 'this site'}</code> in the browser and sign in:
              <div className="mt-2 grid items-baseline gap-2 sm:grid-cols-[auto_1fr]">
                <span className="text-muted-foreground">Username</span>
                <span className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-1">{made.username}</code>
                  <CopyButton text={made.username} label="Copy username" />
                </span>
                <span className="text-muted-foreground">Password</span>
                {made.password ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="rounded bg-muted px-1">{made.password}</code>
                    <CopyButton text={made.password} label="Copy temporary password" />
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    The temporary password you set. Forgotten it? Set a new one on their row on Members.
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted-foreground">They choose their own password straight away.</p>
            </li>
            <li>
              Get the OurHome app: this server hasn’t built it yet, so there’s no download on the Profile page. Ask
              whoever runs your server.
            </li>
            <li>Open the downloaded file to install it. Android asks once to allow installs from the browser.</li>
            <li>
              Open <strong>Our Home</strong> and sign in with their new password. If it asks for the server, type{' '}
              <code className="rounded bg-muted px-1">{address || 'this site'}</code>.
            </li>
            <li>
              <strong>Set up this phone</strong> opens by itself. Do each step on their phone. For{' '}
              <strong>Prevent uninstall</strong> you choose the parent PIN, so keep it to yourself.
            </li>
          </ol>
        )}
        {watching ? null : (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            You don’t supervise {made.name}, so you won’t see their phone here.{' '}
            {supervisorNames.join(' and ')}{' '}
            {locationOn ? 'can follow how far it got on People you look after.' : 'are told if anything is turned off later.'}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {watching ? (
            <Button onClick={onNext}>
              Next: watch their phone <ArrowRight />
            </Button>
          ) : (
            <Link href="/members" className={buttonVariants()}>
              Done
            </Link>
          )}
          <Button variant="ghost" onClick={onAnother}>
            Set up another child
          </Button>
        </div>
      </CardContent>
    </>
  );
}

/**
 * The setup link for their phone, as a QR code and a link to copy. Made once
 * when Install opens; each new one (the button) replaces the last on the
 * server, so it's never remade by itself (no refetch on focus or remount).
 */
function SetupLinkBox({ memberId, name }: { memberId: string; name: string }) {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['setup-link', memberId],
    queryFn: () =>
      apiFetch<SetupLinkDTO>('/api/members/setup-link', { method: 'POST', body: JSON.stringify({ memberId }) }),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  return (
    <div className="mt-2 space-y-2">
      {data ? (
        <>
          <QrCode qr={data.qr} label={`QR code for setting up ${name}’s phone`} className="size-44 rounded-md" />
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-1 text-xs break-all">{data.url}</code>
            <CopyButton text={data.url} label="Copy the setup link" />
          </div>
          <p className="text-xs text-muted-foreground">
            It works for 24 hours, until you make a new one, or until they choose their own password. It only
            downloads the app: their account still needs the password.
          </p>
        </>
      ) : error ? (
        <p className="text-sm text-destructive">{error instanceof Error ? error.message : 'Couldn’t make a setup link.'}</p>
      ) : (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Making a setup link…
        </div>
      )}
      <Button variant="ghost" size="sm" disabled={isFetching} onClick={() => refetch()}>
        <RefreshCw className="size-4" /> {data ? 'Make a new link' : 'Try again'}
      </Button>
    </div>
  );
}

function ProgressStep({
  made,
  locationOn,
  onBack,
  onAnother,
}: {
  made: Made;
  locationOn: boolean;
  onBack: () => void;
  onAnother: () => void;
}) {
  // The same list People you look after shows; refetched often while open here.
  const { data, isPending } = useQuery({
    queryKey: LOOK_AFTER_KEY,
    queryFn: () => apiFetch<LookAfterDTO>('/api/supervision/mine'),
    refetchInterval: PROGRESS_REFETCH_MS,
  });
  const person = data?.people.find((p) => p.id === made.id) ?? null;
  const complete = person ? setupComplete(person) : false;

  return (
    <>
      <CardHeader>
        <CardTitle>{made.name}’s phone</CardTitle>
        <CardDescription>
          This fills in as their phone checks in, a few seconds after each step. You can leave this page: it’s also
          under their name on People you look after.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : person ? (
          <SetupSteps person={person} />
        ) : (
          <p className="text-sm text-muted-foreground">
            You no longer supervise {made.name}, so their phone isn’t shown here.
          </p>
        )}
        {complete ? (
          <div className="flex items-center gap-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 p-3 text-sm">
            <PartyPopper className="size-4 shrink-0" /> {made.name}’s phone is set up.
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> Install steps
          </Button>
          {locationOn ? (
            <Link
              href={`/look-after?person=${encodeURIComponent(made.id)}`}
              className={buttonVariants({ variant: complete ? 'default' : 'outline' })}
            >
              People you look after
            </Link>
          ) : null}
          <Button variant="ghost" onClick={onAnother}>
            Set up another child
          </Button>
        </div>
      </CardContent>
    </>
  );
}
