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
import { Select } from '@/components/ui/select';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Head only: the time→points rate, and the calendar the stats and task
 *  cycles use (time zone, first day of the week). */
export function PointsCard({ initial }: { initial: PointsSettingsDTO }) {
  const [minutesPerPoint, setMinutesPerPoint] = useState(String(initial.minutesPerPoint));
  const [timezone, setTimezone] = useState(initial.timezone);
  const [weekStartsOn, setWeekStartsOn] = useState(initial.weekStartsOn);

  const save = useMutation({
    mutationFn: () =>
      apiFetch<PointsSettingsDTO>('/api/points/settings', {
        method: 'POST',
        body: JSON.stringify({
          minutesPerPoint: Number(minutesPerPoint),
          timezone: timezone.trim(),
          weekStartsOn,
        }),
      }),
    onSuccess: (s) => {
      setMinutesPerPoint(String(s.minutesPerPoint));
      setTimezone(s.timezone);
      setWeekStartsOn(s.weekStartsOn);
      toast.success('Points settings saved');
    },
  });

  const rate = Number(minutesPerPoint);
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2">
          <Trophy className="size-4" />
          <h2 className="font-semibold">Task points</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="mpp">Minutes per point</Label>
            <Input
              id="mpp"
              type="number"
              min={0.1}
              step={0.1}
              value={minutesPerPoint}
              onChange={(e) => setMinutesPerPoint(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {rate > 0 ? `45 min of work = ${Math.round((45 / rate) * 100) / 100} pts.` : ''} Only new
              calculations use it; existing tasks keep their points.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tz">Time zone</Label>
            <Input id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Chicago" />
            <p className="text-xs text-muted-foreground">Days, weeks and task cycles start at midnight here.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wk">Weeks start on</Label>
            <Select id="wk" value={weekStartsOn} onChange={(e) => setWeekStartsOn(Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !(rate > 0)}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
