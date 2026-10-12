'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MapPin, Radio } from 'lucide-react';
import { isSharing, type LocationConsent } from '@/lib/location';
import { canChangeOwnSharing } from '@/lib/permissions';
import type { LiveCheckDTO, LiveChecksOverviewDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { RelativeTime } from '@/components/household-zone';

const CONSENT_KEY = ['location-consent'];
export const LIVE_CHECKS_KEY = ['live-checks'];

/**
 * Profile → Location: the member's own yes or no to sharing where they are,
 * and to short live checks by an adult. Both off until they turn them on.
 * Below: a check running on them right now (with Stop), and every check on
 * them in the last 30 days.
 */
export function LocationCard({ initial }: { initial: LocationConsent }) {
  const queryClient = useQueryClient();
  const { data: consent = initial } = useQuery({
    queryKey: CONSENT_KEY,
    queryFn: () => apiFetch<LocationConsent>('/api/location/consent'),
    initialData: initial,
  });
  const { data: checks } = useQuery({
    queryKey: LIVE_CHECKS_KEY,
    queryFn: () => apiFetch<LiveChecksOverviewDTO>('/api/location/checks'),
    // A running check shows up (and goes away) without a reload.
    refetchInterval: 30_000,
  });

  const update = useMutation({
    mutationFn: (change: { sharing: 'off' | 'on' } | { liveChecks: boolean }) =>
      apiFetch<LocationConsent>('/api/location/consent', { method: 'PATCH', body: JSON.stringify(change) }),
    onSuccess: (next, change) => {
      queryClient.setQueryData(CONSENT_KEY, next);
      queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY });
      if ('sharing' in change) toast.success(isSharing(next.sharing) ? 'Location sharing on' : 'Location sharing off');
      else toast.success(next.liveChecks ? 'Live checks allowed' : 'Live checks off');
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) =>
      apiFetch<LiveCheckDTO>('/api/location/checks/stop', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: () => {
      toast.success('Live check stopped');
      queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY });
    },
  });

  const sharing = isSharing(consent.sharing);
  const locked = !canChangeOwnSharing(consent.sharing);
  const onMe = checks?.onMe ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="size-4" /> Location
        </CardTitle>
        <CardDescription>Off until you turn it on. You can change it any time.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {onMe ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              <Radio className="size-4 text-primary" />
              {onMe.requesterName} is checking where you are until{' '}
              {new Date(onMe.endsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
            </span>
            {!locked ? (
              <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate(onMe.id)}>
                Stop
              </Button>
            ) : null}
          </div>
        ) : null}

        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 rounded border-input"
            checked={sharing}
            disabled={locked || update.isPending}
            onChange={(e) => update.mutate({ sharing: e.target.checked ? 'on' : 'off' })}
          />
          <span className="space-y-1">
            <span className="flex items-center gap-2 font-medium">
              Share my location with the household
              {update.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            </span>
            <span className="block text-muted-foreground">
              With the Android app, your phone tells the household when you get to or leave a map place (home, a
              store), and where you were at that moment. Only that last spot is kept, never a history. Store
              reminders need it too.
            </span>
            {locked ? <span className="block text-muted-foreground">Sharing is required for you.</span> : null}
          </span>
        </label>

        {sharing ? (
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 rounded border-input"
              checked={consent.liveChecks}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ liveChecks: e.target.checked })}
            />
            <span className="space-y-1">
              <span className="block font-medium">Allow live checks</span>
              <span className="block text-muted-foreground">
                An adult in the household can see where you are for a few minutes, updated every minute or
                more often. Your phone shows a notification the whole time, you can stop it there, and every
                check is listed below.
              </span>
            </span>
          </label>
        ) : null}

        {checks && checks.log.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Live checks on you</p>
            <ul className="divide-y divide-border text-sm">
              {checks.log.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span>
                    <span className="font-medium">{entry.requesterName}</span>
                    <span className="text-muted-foreground">
                      {' · '}
                      {logDetail(entry.startedAt, entry.endedAt, entry.stoppedBy, entry.answered)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <RelativeTime date={entry.startedAt} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">Kept for 30 days.</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** "5 min", "running", "stopped by you after 2 min", "phone didn't answer". */
function logDetail(startedAt: string, endedAt: string | null, stoppedBy: string | null, answered: boolean): string {
  if (!endedAt) return 'running now';
  if (!answered) return 'your phone didn’t answer';
  const minutes = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000));
  if (stoppedBy === 'me') return `stopped by you after ${minutes} min`;
  if (stoppedBy === 'requester') return `${minutes} min, stopped early`;
  return `${minutes} min`;
}
