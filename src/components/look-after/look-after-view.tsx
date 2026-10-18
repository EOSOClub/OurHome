'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, HeartHandshake, Loader2 } from 'lucide-react';
import type { LookAfterDTO, RingDTO, UsageHistoryDTO } from '@/lib/types';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { LIVE_CHECKS_KEY } from '@/components/profile/location-card';
import { RelativeTime } from '@/components/household-zone';
import {
  PHONE_PROBLEM_LABELS,
  PHONE_RULES,
  PHONE_RULE_LABELS,
  SILENT_PROBLEMS,
  type PhoneRule,
} from '@/lib/phoneHealth';
import { formatMinutes, usageDayLabel } from '@/lib/appUsage';
import { RING_MS, ringActive, ringOutcome } from '@/lib/ring';
import { SetupProgress } from '@/components/look-after/setup-progress';
import { AppList, UsageHistory } from '@/components/look-after/usage-history';

// The "People you look after" page: the children and teens the viewer
// supervises (the Head's supervision list). Ring their phone, make their
// location sharing required, share their app usage, choose which protections
// their phone must have on (PHONE_RULES). Only linked for adults
// who supervise someone; the server checks it again.

export const LOOK_AFTER_KEY = ['look-after'];

/** A child's usage history, opened under their latest day (keyed by their id after this). */
const USAGE_HISTORY_KEY = ['usage-history'];

/** Refetched this often while open, so check-ins and usage stay current (the app does the same). */
const REFETCH_MS = 60_000;

/** While a ring of the viewer's is going, so its "ringing" and "Stop was tapped" show in seconds. */
const RING_REFETCH_MS = 3_000;

const ringGoing = (data: LookAfterDTO | undefined) =>
  !!data?.people.some((p) => p.ring && ringActive(p.ring.phase));

/** After asking the phones for fresh usage, look again this long after (they answer in seconds). */
const AFTER_REFRESH_MS = [10_000, 25_000];

export function LookAfterView({ initial }: { initial: LookAfterDTO }) {
  const queryClient = useQueryClient();
  const { data = initial } = useQuery({
    queryKey: LOOK_AFTER_KEY,
    queryFn: () => apiFetch<LookAfterDTO>('/api/supervision/mine'),
    initialData: initial,
    refetchInterval: (query) => (ringGoing(query.state.data) ? RING_REFETCH_MS : REFETCH_MS),
  });

  // Opening the page asks each child's phone whose usage is shared to send it
  // now (a push; the server skips it when it can't or just did). Best effort:
  // the page shows what's stored either way. Once per visit: the ref survives
  // React running the effect twice in development, and the later refetches
  // are harmless after leaving (the query is only marked stale).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const ids = initial.people.filter((p) => p.appUsage.shared).map((p) => p.id);
    if (ids.length === 0) return;
    Promise.all(
      ids.map((supervisedId) =>
        apiFetch<{ asked: boolean }>('/api/supervision/usage/refresh', {
          method: 'POST',
          body: JSON.stringify({ supervisedId }),
        }).catch(() => ({ asked: false })),
      ),
    ).then((answers) => {
      if (!answers.some((a) => a.asked)) return;
      for (const ms of AFTER_REFRESH_MS) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: LOOK_AFTER_KEY });
          queryClient.invalidateQueries({ queryKey: USAGE_HISTORY_KEY });
        }, ms);
      }
    });
  }, [initial, queryClient]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <HeartHandshake className="size-6" /> People you look after
        </h1>
        <p className="text-sm text-muted-foreground">
          The children and teens the Head of House asked you to supervise. Everything you do here is logged in
          Activity.
        </p>
      </div>

      {data.people.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          You don&apos;t look after anyone right now. The Head of House chooses who supervises whom on the Members
          page.
        </p>
      ) : (
        <Card className="max-w-2xl">
          <CardContent className="space-y-3 pt-5">
            <ul className="divide-y divide-border">
              {data.people.map((person) => (
                <PersonRow key={person.id} person={person} canRing={data.canRing} />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              <strong>Ring</strong> rings their phone loudly for up to 30 seconds, even on silent. You see when it
              starts ringing, and whether someone tapped Stop.{' '}
              <strong>Location required</strong> keeps their location sharing on, and lets you check where they are
              on the Map without them allowing it. They always see when you check. <strong>Share app usage</strong>{' '}
              shows you how long they spend in each app; their phone needs Usage access for it. Their phone sends it
              every 15 minutes, and opening this page asks it for the latest numbers. They see the same numbers on their
              Profile. While it&apos;s shared, you&apos;re also told when a new app turns up on their phone.{' '}
              <strong>Require Keep Our Home running</strong> stops OurHome being closed on their phone.{' '}
              <strong>Require Prevent uninstall</strong> stops it being removed without your PIN.{' '}
              <strong>Require Unrestricted battery</strong> stops battery saving from holding back rings and alerts.
              Each one you require is a step in Set up this phone in the app on their phone, and you&apos;re told if
              it gets turned off. Not requiring one only stops the step and the alert: whatever is already on stays
              on.
              {data.canRing
                ? null
                : ' Ringing needs instant phone alerts: Firebase on this server, or Stay connected turned on in the app on their phone.'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * Their phone: what's wrong with it (red), or when it last checked in; then
 * how instant alerts reach it (Stay connected, or when the last one arrived).
 */
function PhoneLine({ phone }: { phone: LookAfterDTO['people'][number]['phone'] }) {
  if (!phone) {
    return <span className="block text-xs text-muted-foreground">Their phone hasn&apos;t checked in yet</span>;
  }
  return (
    <>
      {phone.problems.length > 0 ? (
        <span className="block text-xs font-medium text-destructive">
          {phone.problems.map((p) => PHONE_PROBLEM_LABELS[p]).join(' · ')}
          {phone.problems.some((p) => SILENT_PROBLEMS.has(p)) ? (
            <>
              {' '}
              (last seen <RelativeTime date={phone.lastSeenAt} />)
            </>
          ) : null}
        </span>
      ) : (
        <span className="block text-xs text-muted-foreground">
          Phone checked in <RelativeTime date={phone.lastSeenAt} />
        </span>
      )}
      <AlertsLine phone={phone} />
    </>
  );
}

/** How instant alerts reach their phone; nothing for an app too old to say. */
function AlertsLine({ phone }: { phone: NonNullable<LookAfterDTO['people'][number]['phone']> }) {
  if (phone.stayConnected) {
    return (
      <span className="block text-xs text-muted-foreground">
        {phone.connected ? 'Stay connected: connected now' : 'Stay connected is on, but it isn’t connected right now'}
      </span>
    );
  }
  if (!phone.lastPushAt) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      Last instant alert reached it <RelativeTime date={phone.lastPushAt} />
    </span>
  );
}

/** The viewer's last ring of their phone and what the phone said back. */
function RingLine({ ring }: { ring: RingDTO }) {
  return (
    <span
      className={`block text-xs ${ring.phase === 'no_answer' ? 'text-destructive' : 'text-muted-foreground'}`}
      aria-live="polite"
    >
      You rang <RelativeTime date={ring.sentAt} />: {ringOutcome(ring)}
    </span>
  );
}

/**
 * The latest day their phone reported: total, then the top apps with their
 * icons; then, on request, the week's chart and every app.
 */
function UsageLine({
  personId,
  latest,
}: {
  personId: string;
  latest: LookAfterDTO['people'][number]['appUsage']['latest'];
}) {
  const [open, setOpen] = useState(false);
  if (!latest) {
    return (
      <p className="text-xs text-muted-foreground">
        No app usage from their phone yet. It needs the latest OurHome app, and Usage access allowed.
      </p>
    );
  }
  // en-CA writes the viewer's local date as YYYY-MM-DD, like the phone's day.
  const dayLabel = usageDayLabel(latest.day, new Date().toLocaleDateString('en-CA'));
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {dayLabel}: {formatMinutes(latest.totalMinutes)}
        </span>
        {' · '}updated <RelativeTime date={latest.updatedAt} />
      </p>
      {open ? (
        <UsageHistoryPanel personId={personId} />
      ) : latest.top.length > 0 ? (
        <AppList apps={latest.top} />
      ) : null}
      <Button
        size="sm"
        variant="link"
        className="h-auto px-0 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Show less' : 'All apps and the last 7 days'}
      </Button>
    </div>
  );
}

/** Their week's chart and every app, loaded when opened and kept current while open. */
function UsageHistoryPanel({ personId }: { personId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: [...USAGE_HISTORY_KEY, personId],
    queryFn: () =>
      apiFetch<UsageHistoryDTO>(`/api/supervision/usage/history?supervisedId=${encodeURIComponent(personId)}`),
    refetchInterval: REFETCH_MS,
  });
  if (isPending) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (isError) return <p className="text-xs text-destructive">Couldn&apos;t load their app usage.</p>;
  return <UsageHistory history={data} />;
}

function PersonRow({ person, canRing }: { person: LookAfterDTO['people'][number]; canRing: boolean }) {
  const queryClient = useQueryClient();
  // Rests while the phone rings, so a second tap can't be refused by the
  // server; until their phone says the ring ended, when the server allows another.
  const [ringingUntil, setRingingUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const ringEnded = person.ring?.phase === 'stopped' || person.ring?.phase === 'rang_out';
  const ringing = now < ringingUntil && !ringEnded;
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setNow(Date.now()), ringingUntil - now);
    return () => clearTimeout(t);
  }, [ringing, ringingUntil, now]);

  const ring = useMutation({
    // A refetch already on its way mustn't put the last ring back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: () =>
      apiFetch<{ rung: boolean; ring: RingDTO }>('/api/supervision/ring', {
        method: 'POST',
        body: JSON.stringify({ targetId: person.id }),
      }),
    onSuccess: ({ ring }) => {
      const at = Date.now();
      // The new ring at once, so the last one's ending doesn't free the button;
      // the page then looks every few seconds for what their phone says.
      queryClient.setQueryData<LookAfterDTO>(LOOK_AFTER_KEY, (d) =>
        d ? { ...d, people: d.people.map((p) => (p.id === person.id ? { ...p, ring } : p)) } : d,
      );
      setNow(at);
      setRingingUntil(at + RING_MS);
      toast.success(`Ringing ${person.name}’s phone`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not ring their phone.'),
  });

  // A refetch already on its way (window focus) mustn't put the old value back.
  const cancelRefetch = () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY });

  const require = useMutation({
    onMutate: cancelRefetch,
    mutationFn: (required: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/sharing', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, required }),
      }),
    onSuccess: (next, required) => {
      // Set before the pending state ends, so the box never flicks back.
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      // Who may be checked changes with it.
      queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY });
      toast.success(
        required ? `${person.name}’s location sharing is now required` : `${person.name} can turn sharing off again`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });

  const usage = useMutation({
    onMutate: cancelRefetch,
    mutationFn: (share: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/usage', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, share }),
      }),
    onSuccess: (next, share) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(share ? `${person.name}’s app usage will be shared` : `${person.name}’s app usage is no longer shared`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });

  const required = require.isPending ? require.variables : person.sharing === 'required';
  const sharesUsage = usage.isPending ? usage.variables : person.appUsage.shared;
  const sharingNote =
    person.sharing === 'required' ? null : person.sharing === 'on' ? 'Shares their location' : 'Not sharing their location';

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{person.name}</span>
          {sharingNote ? <span className="block text-xs text-muted-foreground">{sharingNote}</span> : null}
          <PhoneLine phone={person.phone} />
          {person.ring ? <RingLine ring={person.ring} /> : null}
        </span>
        {canRing ? (
          <Button size="sm" variant="outline" disabled={ring.isPending || ringing} onClick={() => ring.mutate()}>
            {ring.isPending ? <Loader2 className="animate-spin" /> : <BellRing />}
            {ringing ? 'Ringing' : 'Ring'}
          </Button>
        ) : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={required}
          disabled={require.isPending}
          onChange={(e) => require.mutate(e.target.checked)}
        />
        Location required
        {require.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={sharesUsage}
          disabled={usage.isPending}
          onChange={(e) => usage.mutate(e.target.checked)}
        />
        Share app usage
        {usage.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      </label>
      {person.appUsage.shared ? <UsageLine personId={person.id} latest={person.appUsage.latest} /> : null}
      {PHONE_RULES.map((rule) => (
        <RuleBox key={rule} person={person} rule={rule} />
      ))}
      <SetupProgress person={person} />
    </li>
  );
}

/** One protection their phone must have on, saved with each tick. */
function RuleBox({ person, rule }: { person: LookAfterDTO['people'][number]; rule: PhoneRule }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    // A refetch already on its way (window focus) mustn't put the old value back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (required: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/phone-rules', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, rule, required }),
      }),
    onSuccess: (next, required) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(
        required
          ? `${PHONE_RULE_LABELS[rule]} is now required on ${person.name}’s phone`
          : `${PHONE_RULE_LABELS[rule]} is no longer required on ${person.name}’s phone`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  const checked = save.isPending ? save.variables : person.rules[rule];
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 rounded border-input"
        checked={checked}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.checked)}
      />
      Require {PHONE_RULE_LABELS[rule]}
      {save.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </label>
  );
}
