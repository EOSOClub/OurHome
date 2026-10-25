'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Timer } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import type { MyExtraTimeDTO } from '@/lib/types';
import { formatMinutes } from '@/lib/appUsage';
import { formatPoints } from '@/lib/taskPoints';
import { buyOptions, rateLabel } from '@/lib/pointsTime';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/collapsible-card';
import { toast } from '@/components/ui/toast';

// On a child's or teen's own Profile, while an adult who looks after them
// lets them spend points on screen time (pointsTimeService): their points to
// spend, what a point buys, and buttons to buy more time on today's limits.
// Today is this browser's date, like their phone's. Nothing shows otherwise.

const KEY = ['my-extra-time'];

export function ExtraTimeCard() {
  const queryClient = useQueryClient();
  // en-CA writes the local date as YYYY-MM-DD, like the phone's day.
  const day = new Date().toLocaleDateString('en-CA');
  const { data } = useQuery({
    queryKey: [...KEY, day],
    queryFn: () => apiFetch<MyExtraTimeDTO>(`/api/phone/extra-time?day=${day}`),
  });
  const buy = useMutation({
    mutationFn: (minutes: number) =>
      apiFetch<MyExtraTimeDTO>('/api/phone/extra-time', { method: 'POST', body: JSON.stringify({ minutes, day }) }),
    onSuccess: (next, minutes) => {
      queryClient.setQueryData([...KEY, day], next);
      toast.success(`${formatMinutes(minutes)} more on your limits today`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not buy it.'),
  });
  if (!data || data.minutesPerPoint === null || data.dailyCap === null) return null;
  const options = data.available
    ? buyOptions({
        balanceCenti: data.balanceCenti,
        minutesPerPoint: data.minutesPerPoint,
        dailyCap: data.dailyCap,
        boughtToday: data.bought,
      })
    : [];
  const left = Math.max(0, data.dailyCap - data.bought);
  return (
    <SectionCard
      icon={<Timer className="size-5" />}
      title="More screen time"
      description="Spend your task points on more time on today's limits."
      contentClassName="space-y-3 pt-0 text-sm text-muted-foreground"
    >
      <p>
        You have <strong className="text-foreground">{formatPoints(Math.max(0, data.balanceCenti))} points</strong> to
        spend. {rateLabel(data.minutesPerPoint)}, up to {formatMinutes(data.dailyCap)} a day.
        {data.bought > 0 ? ` You've bought ${formatMinutes(data.bought)} today.` : ''}
        {data.given > 0 ? ` An adult gave you ${formatMinutes(data.given)} today.` : ''}
      </p>
      {!data.hasLimits ? (
        <p>You have no daily limits right now, so there&apos;s nothing to add time to.</p>
      ) : left === 0 ? (
        <p>You&apos;ve bought all the time you can today.</p>
      ) : options.length === 0 ? (
        <p>You don&apos;t have enough points for more time yet. Finishing tasks earns them.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              key={o.minutes}
              size="sm"
              variant="outline"
              disabled={buy.isPending}
              onClick={() => buy.mutate(o.minutes)}
            >
              {buy.isPending && buy.variables === o.minutes ? <Loader2 className="animate-spin" /> : null}+
              {formatMinutes(o.minutes)} · {formatPoints(o.costCenti)} {o.costCenti === 100 ? 'point' : 'points'}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs">
        Spending doesn&apos;t change the points you&apos;ve earned in the stats. The adults who look after you are told.
      </p>
    </SectionCard>
  );
}
