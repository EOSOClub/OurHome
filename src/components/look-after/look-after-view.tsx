'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, HeartHandshake, Loader2 } from 'lucide-react';
import type { LookAfterDTO } from '@/lib/types';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { LIVE_CHECKS_KEY } from '@/components/profile/location-card';
import { RelativeTime } from '@/components/household-zone';
import { PHONE_PROBLEM_LABELS } from '@/lib/phoneHealth';
import { formatMinutes, usageDayLabel } from '@/lib/appUsage';

// The "People you look after" page: the children and teens the viewer
// supervises (the Head's supervision list). Ring their phone, make their
// location sharing required, share their app usage. Only linked for adults
// who supervise someone; the server checks it again.

const LOOK_AFTER_KEY = ['look-after'];

/** How long the phone rings, and so how long the button rests. */
const RING_MS = 30_000;

export function LookAfterView({ initial }: { initial: LookAfterDTO }) {
  const { data = initial } = useQuery({
    queryKey: LOOK_AFTER_KEY,
    queryFn: () => apiFetch<LookAfterDTO>('/api/supervision/mine'),
    initialData: initial,
  });

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
              <strong>Ring</strong> rings their phone loudly for up to 30 seconds, even on silent.{' '}
              <strong>Location required</strong> keeps their location sharing on, and lets you check where they are
              on the Map without them allowing it. They always see when you check. <strong>Share app usage</strong>{' '}
              shows you how long they spend in each app; their phone needs Usage access for it.
              {data.canRing ? null : ' Ringing needs instant phone alerts, which this server doesn’t have set up.'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Their phone: what's wrong with it (red), or when it last checked in. */
function PhoneLine({ phone }: { phone: LookAfterDTO['people'][number]['phone'] }) {
  if (!phone) {
    return <span className="block text-xs text-muted-foreground">Their phone hasn&apos;t checked in yet</span>;
  }
  if (phone.problems.length > 0) {
    return (
      <span className="block text-xs font-medium text-destructive">
        {phone.problems.map((p) => PHONE_PROBLEM_LABELS[p]).join(' · ')}
        {phone.problems.includes('quiet') ? (
          <>
            {' '}
            (last seen <RelativeTime date={phone.lastSeenAt} />)
          </>
        ) : null}
      </span>
    );
  }
  return (
    <span className="block text-xs text-muted-foreground">
      Phone checked in <RelativeTime date={phone.lastSeenAt} />
    </span>
  );
}

/** The latest day their phone reported: total, then the top apps. */
function UsageLine({ latest }: { latest: LookAfterDTO['people'][number]['appUsage']['latest'] }) {
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
    <p className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {dayLabel}: {formatMinutes(latest.totalMinutes)}
      </span>
      {latest.top.length > 0
        ? ` · ${latest.top.map((a) => `${a.label} ${formatMinutes(a.minutes)}`).join(', ')}`
        : null}
      {' · '}updated <RelativeTime date={latest.updatedAt} />
    </p>
  );
}

function PersonRow({ person, canRing }: { person: LookAfterDTO['people'][number]; canRing: boolean }) {
  const queryClient = useQueryClient();
  // Rests while the phone rings, so a second tap can't be refused by the server.
  const [ringingUntil, setRingingUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const ringing = now < ringingUntil;
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setNow(Date.now()), ringingUntil - now);
    return () => clearTimeout(t);
  }, [ringing, ringingUntil, now]);

  const ring = useMutation({
    mutationFn: () =>
      apiFetch<{ rung: boolean }>('/api/supervision/ring', {
        method: 'POST',
        body: JSON.stringify({ targetId: person.id }),
      }),
    onSuccess: () => {
      const at = Date.now();
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
      {person.appUsage.shared ? <UsageLine latest={person.appUsage.latest} /> : null}
    </li>
  );
}
