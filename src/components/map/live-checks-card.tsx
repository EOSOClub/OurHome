'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Radio } from 'lucide-react';
import type { LiveCheckDTO, LiveChecksOverviewDTO } from '@/lib/types';
import { fixAge } from '@/lib/location';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { LIVE_CHECKS_KEY } from '@/components/profile/location-card';
import { everyLabel, minutesLabel } from '@/components/settings/live-check-card';

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function statusText(check: LiveCheckDTO): string {
  if (check.state === 'waiting') return 'waiting for their phone';
  if (check.state === 'no_answer') return 'their phone hasn’t answered';
  if (check.fix) return fixAge(check.fix.at);
  return 'live';
}

/**
 * Map page: live location checks. The members this viewer may check (adults,
 * on people who allow it), the checks they have running with Stop, and the
 * dialog to start one within the household's limits.
 */
export function LiveChecksCard({
  overview,
  onFocus,
}: {
  overview: LiveChecksOverviewDTO;
  /** Zoom the map to a check's latest fix. */
  onFocus: (check: LiveCheckDTO) => void;
}) {
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState<{ id: string; name: string } | null>(null);
  const [minutes, setMinutes] = useState(overview.choices.defaultMinutes);
  const [intervalSec, setIntervalSec] = useState(overview.choices.defaultIntervalSec);

  const start = useMutation({
    mutationFn: (targetId: string) =>
      apiFetch<LiveCheckDTO>('/api/location/checks', {
        method: 'POST',
        body: JSON.stringify({ targetId, minutes, intervalSec }),
      }),
    onSuccess: (check) => {
      setStarting(null);
      toast.success(`Checking on ${check.targetName} until ${clock(check.endsAt)}`);
      void queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY });
    },
  });
  const stop = useMutation({
    mutationFn: (id: string) =>
      apiFetch<LiveCheckDTO>('/api/location/checks/stop', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY }),
  });

  const runningOn = new Set(overview.started.map((c) => c.targetId));
  const idle = overview.checkable.filter((m) => !runningOn.has(m.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Radio className="size-4" /> Live check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {overview.started.map((check) => (
          <div key={check.id} className="space-y-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-sm">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="truncate font-medium hover:underline disabled:no-underline"
                disabled={!check.fix}
                onClick={() => onFocus(check)}
              >
                {check.targetName}
              </button>
              <Button size="sm" variant="ghost" disabled={stop.isPending} onClick={() => stop.mutate(check.id)}>
                Stop
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Until {clock(check.endsAt)} · {statusText(check)}
            </p>
          </div>
        ))}

        {!overview.available ? (
          <p className="text-sm text-muted-foreground">
            Live checks need instant phone alerts: Firebase on this server, or Stay connected turned on in the app on
            their phone.
          </p>
        ) : idle.length === 0 && overview.started.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody to check. Someone shows up here once they share their location and allow live checks on
            their Profile.
          </p>
        ) : (
          <ul className="space-y-1">
            {idle.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{member.name}</span>
                <Button size="sm" variant="outline" onClick={() => setStarting(member)}>
                  Check location
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={!!starting}
        onClose={() => setStarting(null)}
        title={starting ? `Check where ${starting.name} is?` : 'Check location'}
        description="Their phone shows a notification the whole time, and they can stop it. It's listed on their Profile."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStarting(null)} disabled={start.isPending}>
              Cancel
            </Button>
            <Button onClick={() => starting && start.mutate(starting.id)} disabled={start.isPending}>
              {start.isPending ? <Loader2 className="animate-spin" /> : null}
              Start
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="lc-minutes">For</Label>
            <Select id="lc-minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {overview.choices.minutes.map((m) => (
                <option key={m} value={m}>
                  {minutesLabel(m)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="lc-every">Update</Label>
            <Select id="lc-every" value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))}>
              {overview.choices.intervals.map((s) => (
                <option key={s} value={s}>
                  {everyLabel(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
