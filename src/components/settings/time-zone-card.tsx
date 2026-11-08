'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { CalendarClock, Loader2 } from 'lucide-react';
import type { PointsSettingsDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Picked from a list, not typed: a free-text zone was easy to get wrong. The
// server still checks whatever is sent.
const NO_ZONES: readonly string[] = [];
// For a browser without Intl.supportedValuesOf: the common zones.
const FALLBACK_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Halifax',
  'America/St_Johns',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland',
];
let zoneCache: readonly string[] | null = null;

function browserZones(): readonly string[] {
  if (zoneCache) return zoneCache;
  let list: string[];
  try {
    list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_ZONES;
  } catch {
    list = FALLBACK_ZONES;
  }
  // Some browsers leave UTC out of the list.
  zoneCache = list.includes('UTC') ? list : ['UTC', ...list];
  return zoneCache;
}

function subscribeNever() {
  return () => {};
}

/** The list, with the current zone kept selectable even when it isn't in it. */
function zoneOptions(zones: readonly string[], current: string): readonly string[] {
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}

/** Head only: the household's calendar (time zone, first day of the week).
 *  Stored with the points rate, so it saves through the same endpoint. */
export function TimeZoneCard({ initial }: { initial: PointsSettingsDTO }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initial.timezone);
  const [weekStartsOn, setWeekStartsOn] = useState(initial.weekStartsOn);
  const [savedZone, setSavedZone] = useState(initial.timezone);
  const fe = useFieldErrors('tz-card');
  // The browser's list, read after hydration: the server's list can differ
  // from the browser's, and a mismatch would break hydration.
  const zones = useSyncExternalStore(subscribeNever, browserZones, () => NO_ZONES);

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
    // Beside Task points on wide screens: same height, same layout, Saves in line.
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-4 p-5" {...fe.formProps}>
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
            <Select
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              {...fe.invalid('timezone')}
            >
              {zoneOptions(zones, timezone).map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
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
        <div className="mt-auto flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !timezone.trim()}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
