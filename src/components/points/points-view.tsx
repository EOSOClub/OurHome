'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, Trophy } from 'lucide-react';
import type { PointAwardDTO, PointsSummaryDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { addDays, parseLocalDate, type LocalDate } from '@/lib/taskCycles';
import { cn } from '@/lib/utils';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { RelativeTime } from '@/components/household-zone';

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

function iso(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

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
      return start.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    case 'week':
      return `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    case 'month':
      return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
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
  const { data: awards = [], isPending: awardsPending } = useQuery({
    queryKey: ['points', 'awards', period, date, member],
    queryFn: () =>
      apiFetch<PointAwardDTO[]>(`/api/points/awards?${params}${member ? `&userId=${member}` : ''}`),
    placeholderData: keepPreviousData,
  });

  const voidMutation = useMutation({
    mutationFn: (vars: { awardId: string; reason: string }) =>
      apiFetch<PointAwardDTO>('/api/points/awards/void', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: () => {
      setVoiding(null);
      setReason('');
      toast.success('Points voided');
      queryClient.invalidateQueries({ queryKey: ['points'] });
    },
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
                'rounded px-3 py-1 text-sm font-medium',
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
            // Back to "now" once the next period is the current one.
            setDate(new Date(`${next}T12:00:00`) > new Date() ? null : next);
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
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{m.queued || '—'}</td>
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
        {awardsPending ? (
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
                    {a.stepTitle ? <span className="text-muted-foreground"> — {a.stepTitle}</span> : null}
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
        onClose={() => setVoiding(null)}
        title="Void these points?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setVoiding(null)} disabled={voidMutation.isPending}>
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
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" maxLength={200} />
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
