'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Trophy } from 'lucide-react';
import type { PointsSettingsDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

/** Head only: the time→points rate. The time zone and week start are on
 *  their own card (time-zone-card.tsx). */
export function PointsCard({ initial }: { initial: PointsSettingsDTO }) {
  const [minutesPerPoint, setMinutesPerPoint] = useState(String(initial.minutesPerPoint));
  const fe = useFieldErrors('points-card');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<PointsSettingsDTO>('/api/points/settings', {
        method: 'POST',
        body: JSON.stringify({ minutesPerPoint: Number(minutesPerPoint) }),
      }),
    onSuccess: (s) => {
      setMinutesPerPoint(String(s.minutesPerPoint));
      toast.success('Points settings saved');
    },
    onError: fe.fail,
  });

  const rate = Number(minutesPerPoint);
  const rateError =
    fe.get('minutesPerPoint') ?? (minutesPerPoint !== '' && !(rate > 0) ? 'Enter a number above 0.' : null);
  return (
    // Beside Time zone and week on wide screens: same height, same layout, Saves in line.
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-4 p-5" {...fe.formProps}>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Trophy className="size-4" />
            <h2 className="font-semibold">Task points</h2>
          </div>
          <p className="text-sm text-muted-foreground">Tasks earn points by how long they take.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2" data-field="minutesPerPoint">
            <Label htmlFor="mpp">Minutes per point</Label>
            <Input
              id="mpp"
              type="number"
              min={0.1}
              step={0.1}
              value={minutesPerPoint}
              onChange={(e) => setMinutesPerPoint(e.target.value)}
              aria-invalid={rateError ? true : undefined}
              aria-describedby={`${fe.noteId('minutesPerPoint')} mpp-example`}
            />
            <FieldNote
              id={fe.noteId('minutesPerPoint')}
              error={rateError}
              hint="Only new calculations use it; existing tasks keep their points."
            />
          </div>
          <div className="space-y-2">
            {/* Inline like the Label beside it, so the two rows line up. */}
            <span className="text-sm font-medium leading-none text-foreground">For example</span>
            <p
              id="mpp-example"
              className="flex h-11 items-center rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground"
            >
              {rate > 0 ? `45 min of work = ${Math.round((45 / rate) * 100) / 100} pts` : 'Enter a rate to see one.'}
            </p>
          </div>
        </div>
        <div className="mt-auto flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !(rate > 0)}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
