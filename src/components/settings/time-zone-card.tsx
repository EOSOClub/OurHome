'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, Loader2 } from 'lucide-react';
import type { PointsSettingsDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Head only: the household's calendar (time zone, first day of the week).
 *  Stored with the points rate, so it saves through the same endpoint. */
export function TimeZoneCard({ initial }: { initial: PointsSettingsDTO }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [weekStartsOn, setWeekStartsOn] = useState(initial.weekStartsOn);
  const [savedZone, setSavedZone] = useState(initial.timezone);
  const fe = useFieldErrors('tz-card');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<PointsSettingsDTO>('/api/points/settings', {
        method: 'POST',
        body: JSON.stringify({ timezone: timezone.trim(), weekStartsOn }),
      }),
    onSuccess: (s) => {
      setTimezone(s.timezone);
      setWeekStartsOn(s.weekStartsOn);
      // Dates on screen come from the layout's zone: re-render it with the new one.
      if (s.timezone !== savedZone) router.refresh();
      setSavedZone(s.timezone);
      toast.success('Time zone and week saved');
    },
    onError: fe.fail,
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-5" {...fe.formProps}>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4" />
            <h2 className="font-semibold">Time zone and week</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Everyone sees dates and times in this time zone, whatever their own device is set to.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2" data-field="timezone">
            <Label htmlFor="tz">Time zone</Label>
            <Input
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="America/Chicago"
              {...fe.invalid('timezone')}
            />
            <FieldNote
              id={fe.noteId('timezone')}
              error={fe.get('timezone')}
              hint="Days, weeks and task cycles start at midnight here."
            />
          </div>
          <div className="space-y-2" data-field="weekStartsOn">
            <Label htmlFor="wk">Weeks start on</Label>
            <Select
              id="wk"
              value={weekStartsOn}
              onChange={(e) => setWeekStartsOn(Number(e.target.value))}
              {...fe.invalid('weekStartsOn')}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
            <FieldNote id={fe.noteId('weekStartsOn')} error={fe.get('weekStartsOn')} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !timezone.trim()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
