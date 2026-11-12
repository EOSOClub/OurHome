'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, Trophy } from 'lucide-react';
import type { PointAwardDTO, PointsSummaryDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { addDays, parseLocalDate } from '@/lib/taskCycles';
import { APP_LOCALE, dateKey } from '@/lib/format';
import { cn } from '@/lib/utils';
import { iso, nextPeriodDate } from '@/components/points/points-period';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';
import { RelativeTime, useHouseholdZone } from '@/components/household-zone';

type Period = PointsSummaryDTO['period'];
const PERIODS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

const KIND_LABELS: Record<string, string> = {
  task: 'Task',
  step: 'Step',
  step_repeat: 'Step again',
};

/** A date inside the previous/next period, from the current period's start. */
function shift(summary: PointsSummaryDTO, direction: -1 | 1): string {
  const start = parseLocalDate(summary.startDate)!;
  if (direction === -1) return iso(addDays(start, -1));
  return iso(addDays(start, summary.days));
}

function periodTitle(s: PointsSummaryDTO): string {
  const start = new Date(`${s.startDate}T12:00:00`);
  switch (s.period) {
    case 'day':
      return start.toLocaleDateString(APP_LOCALE, { weekday: 'long', month: 'short', day: 'numeric' });
    case 'week':
      return `Week of ${start.toLocaleDateString(APP_LOCALE, { month: 'short', day: 'numeric' })}`;
    case 'month':
      return start.toLocaleDateString(APP_LOCALE, { month: 'long', year: 'numeric' });
    case 'year':
      return String(start.getFullYear());
  }
}

export function PointsView({
  initialSummary,
  userId,
  isHead,
}: {
  initialSummary: PointsSummaryDTO;
  userId: string;
  isHead: boolean;
}) {
  const queryClient = useQueryClient();
  const timeZone = useHouseholdZone();
  const [period, setPeriod] = useState<Period>('week');
  const [date, setDate] = useState<string | null>(null);
  const [member, setMember] = useState('');
  const [voiding, setVoiding] = useState<PointAwardDTO | null>(null);
  const [reason, setReason] = useState('');

  const params = `period=${period}${date ? `&date=${date}` : ''}`;
  const { data: summary = initialSummary, isFetching } = useQuery({
    queryKey: ['points', 'summary', period, date],
    queryFn: () => apiFetch<PointsSummaryDTO>(`/api/points/summary?${params}`),
    initialData: period === 'week' && !date ? initialSummary : undefined,
    placeholderData: keepPreviousData,
  });
  const {
    data: awards = [],
    isPending: awardsPending,
    isError: awardsError,
    isFetching: awardsFetching,
    refetch: refetchAwards,
  } = useQuery({
    queryKey: ['points', 'awards', period, date, member],
    queryFn: () =>
      apiFetch<PointAwardDTO[]>(`/api/points/awards?${params}${member ? `&userId=${member}` : ''}`),
    placeholderData: keepPreviousData,
  });

  const voidForm = useFieldErrors('void');
  // Closing starts the next one clean: the reason and its error belonged to
  // the award that was open.
  const closeVoid = () => {
    setVoiding(null);
    setReason('');
    voidForm.clear();
  };
  const voidMutation = useMutation({
    mutationFn: (vars: { awardId: string; reason: string }) =>
      apiFetch<PointAwardDTO>('/api/points/awards/void', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => {
      closeVoid();
      toast.success('Points voided');
      void queryClient.invalidateQueries({ queryKey: ['points'] });
    },
    onError: voidForm.fail,
  });

  const isCurrent = !date;
  const top = summary.members[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Trophy className="size-6" /> Points
          </h1>
          <p className="text-sm text-muted-foreground">
            Earned by finishing tasks. Checked steps wait (&quot;queued&quot;) until their task is completed.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                setPeriod(p.value);
                setDate(null);
              }}
              className={cn(
                // min-h-11: a full-size tap target on phones.
                'min-h-11 rounded px-3 py-1 text-sm font-medium sm:min-h-0',
                period === p.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous period" onClick={() => setDate(shift(summary, -1))}>
          <ChevronLeft />
        </Button>
        <div className="min-w-40 text-center font-medium">{periodTitle(summary)}</div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next period"
          disabled={isCurrent}
          onClick={() => {
            const next = shift(summary, 1);
            // Back to "now" once the next period is the current one (holds
            // today in the household's zone).
            setDate(nextPeriodDate(summary.period, next, dateKey(new Date(), timeZone)));
          }}
        >
          <ChevronRight />
        </Button>
        {!isCurrent ? (
          <Button variant="ghost" size="sm" onClick={() => setDate(null)}>
            Today
          </Button>
        ) : null}
        {isFetching ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Household total" value={summary.householdTotal} />
        <Stat label="Average per person" value={summary.averagePerPerson} />
        <Stat
          label="Per person per day"
          value={summary.averagePerPersonPerDay}
          hint={`over ${summary.elapsedDays} day${summary.elapsedDays === 1 ? '' : 's'}`}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Member</th>
                <th className="px-4 py-2 text-right font-medium">Points</th>
                <th className="px-4 py-2 text-right font-medium">Per day</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Entries</th>
                <th className="px-4 py-2 text-right font-medium">Queued</th>
              </tr>
            </thead>
            <tbody>
              {summary.members.map((m) => (
                <tr
                  key={m.userId}
                  className={cn('border-b border-border last:border-0', m.userId === userId && 'bg-accent/40')}
                >
                  <td className="px-4 py-2">
                    {m.name}
                    {top && m === top && m.points > 0 ? <Trophy className="ml-1.5 inline size-3.5 text-amber-500" /> : null}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">{m.points}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{m.perDay}</td>
                  <td className="hidden px-4 py-2 text-right tabular-nums sm:table-cell">{m.awards}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{m.queued || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">History</h2>
          <Select value={member} onChange={(e) => setMember(e.target.value)} className="w-44">
            <option value="">Everyone</option>
            {summary.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        {/* Checked first: a failed load has no awards, and must not read as "no points". */}
        {awardsError && awards.length === 0 ? (
          <LoadError
            message="Couldn't load the points history. Check your connection and try again."
            onRetry={() => void refetchAwards()}
            retrying={awardsFetching}
          />
        ) : awardsPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : awards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No points in this period yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {awards.map((a) => (
              <li key={a.id} className={cn('flex items-center gap-3 px-4 py-2 text-sm', a.voided && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate', a.voided && 'line-through')}>
                    <span className="font-medium">{a.userName ?? 'Former member'}</span> · {a.taskTitle}
                    {a.stepTitle ? <span className="text-muted-foreground"> - {a.stepTitle}</span> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {KIND_LABELS[a.kind] ?? a.kind} · <RelativeTime date={a.awardedAt} />
                    {a.voided ? ` · voided${a.voidReason ? `: ${a.voidReason}` : ''}` : ''}
                  </p>
                </div>
                <span className={cn('tabular-nums font-medium', a.voided && 'line-through')}>{a.points}</span>
                {isHead && !a.voided ? (
                  <Button variant="ghost" size="sm" onClick={() => setVoiding(a)}>
                    Void
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={!!voiding}
        onClose={closeVoid}
        // A stray tap outside must not throw away the reason being typed.
        preventOutsideClose
        title="Void these points?"
        footer={
          <>
            <Button variant="ghost" onClick={closeVoid} disabled={voidMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || voidMutation.isPending}
              onClick={() => voiding && voidMutation.mutate({ awardId: voiding.id, reason: reason.trim() })}
            >
              {voidMutation.isPending ? <Loader2 className="animate-spin" /> : null}
              Void
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {voiding ? `${voiding.points} pts for ${voiding.userName ?? 'a former member'} (“${voiding.taskTitle}”).` : ''}{' '}
            It stays in the history, struck through, and stops counting.
          </p>
          <div data-field="reason" {...voidForm.formProps}>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required)"
              aria-label="Reason"
              maxLength={200}
              {...voidForm.invalid('reason')}
            />
            <FieldNote id={voidForm.noteId('reason')} error={voidForm.get('reason')} />
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
