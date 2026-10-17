'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Radio } from 'lucide-react';
import { LIVE_CHECK_INTERVALS, LIVE_CHECK_MINUTES, type LiveCheckSettings } from '@/lib/location';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

/** "5 minutes", "1 hour", "2 hours"; "15 seconds", "1 minute". */
export function minutesLabel(m: number): string {
  if (m % 60 === 0) return m === 60 ? '1 hour' : `${m / 60} hours`;
  return `${m} minutes`;
}
export function intervalLabel(s: number): string {
  if (s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`;
  return `${s} seconds`;
}
/** "Every minute", "Every 30 seconds". */
export function everyLabel(s: number): string {
  return s === 60 ? 'Every minute' : `Every ${intervalLabel(s)}`;
}

/**
 * Head only: how long a live location check may run and how often it may ask
 * the phone. Whoever starts a check picks within these.
 */
export function LiveCheckCard({ initial }: { initial: LiveCheckSettings }) {
  const [maxMinutes, setMaxMinutes] = useState(initial.maxMinutes);
  const [minIntervalSec, setMinIntervalSec] = useState(initial.minIntervalSec);
  const fe = useFieldErrors('lc-card');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<LiveCheckSettings>('/api/location/checks/settings', {
        method: 'POST',
        body: JSON.stringify({ maxMinutes, minIntervalSec }),
      }),
    onSuccess: (s) => {
      setMaxMinutes(s.maxMinutes);
      setMinIntervalSec(s.minIntervalSec);
      toast.success('Live check limits saved');
    },
    onError: fe.fail,
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-5" {...fe.formProps}>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Radio className="size-4" />
            <h2 className="font-semibold">Live location checks</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            An adult can watch where someone is for a short while, if that person allows it on their Profile.
            Their phone shows it the whole time. These are the limits.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2" data-field="maxMinutes">
            <Label htmlFor="lc-max">Longest check</Label>
            <Select
              id="lc-max"
              value={maxMinutes}
              onChange={(e) => setMaxMinutes(Number(e.target.value))}
              {...fe.invalid('maxMinutes')}
            >
              {LIVE_CHECK_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {minutesLabel(m)}
                </option>
              ))}
            </Select>
            <FieldNote id={fe.noteId('maxMinutes')} error={fe.get('maxMinutes')} />
          </div>
          <div className="space-y-2" data-field="minIntervalSec">
            <Label htmlFor="lc-interval">Most often</Label>
            <Select
              id="lc-interval"
              value={minIntervalSec}
              onChange={(e) => setMinIntervalSec(Number(e.target.value))}
              {...fe.invalid('minIntervalSec')}
            >
              {LIVE_CHECK_INTERVALS.map((s) => (
                <option key={s} value={s}>
                  {everyLabel(s)}
                </option>
              ))}
            </Select>
            <FieldNote
              id={fe.noteId('minIntervalSec')}
              error={fe.get('minIntervalSec')}
              hint="More often uses more of their phone's battery."
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
