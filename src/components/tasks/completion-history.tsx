'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, History, Loader2 } from 'lucide-react';
import type { TaskCompletionDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { formatDate, formatRelativeTime } from '@/lib/format';

/** Show at most this many entries; the rest collapse into a "+N more" line. */
const MAX_VISIBLE = 10;

/**
 * Lazy disclosure of a task's completion history. Nothing is fetched until
 * the user opens the disclosure, so rendering this in every card is cheap.
 */
export function CompletionHistory({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);

  const {
    data: completions,
    isPending,
    isError,
  } = useQuery({
    queryKey: ['task-completions', taskId],
    queryFn: () =>
      apiFetch<TaskCompletionDTO[]>(`/api/tasks/completions?taskId=${taskId}`),
    enabled: open,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <History className="size-3" />
        History
        {open ? (
          <ChevronUp className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )}
      </button>

      {open ? (
        <CompletionList
          completions={completions}
          isPending={isPending}
          isError={isError}
        />
      ) : null}
    </div>
  );
}

function CompletionList({
  completions,
  isPending,
  isError,
}: {
  completions: TaskCompletionDTO[] | undefined;
  isPending: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <p className="mt-1.5 text-xs text-destructive">
        Couldn&apos;t load history.
      </p>
    );
  }

  if (isPending || !completions) {
    return (
      <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading history…
      </p>
    );
  }

  if (completions.length === 0) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">Not completed yet</p>
    );
  }

  const visible = completions.slice(0, MAX_VISIBLE);
  const hidden = completions.length - visible.length;

  return (
    <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
      {visible.map((c) => (
        <li key={c.id} className="flex flex-wrap items-baseline gap-x-2">
          <span title={formatDate(c.completedAt)}>
            {formatRelativeTime(c.completedAt)}
          </span>
          {c.user ? <span>· {c.user.name}</span> : null}
          {c.note ? <span className="italic">“{c.note}”</span> : null}
        </li>
      ))}
      {hidden > 0 ? <li>+{hidden} more</li> : null}
    </ul>
  );
}
