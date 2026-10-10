'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ChevronDown, ListChecks, Loader2, Plus, Trophy } from 'lucide-react';
import type { CategoryDTO, MemberDTO, TaskDTO } from '@/lib/types';
import { TASK_STATUSES, TASK_TYPES, TASK_TYPE_LABELS } from '@/lib/enums';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { TaskCard } from '@/components/tasks/task-card';
import type { PageAccess } from '@/lib/permissions';
import {
  CreateTaskForm,
  type TaskFormPayload,
} from '@/components/tasks/create-task-form';

interface Filters {
  status: string;
  type: string;
  assigneeId: string;
}

type SortKey = 'due' | 'priority' | 'created';

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function buildQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.assigneeId) params.set('assigneeId', filters.assigneeId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// Strip recurrence:null (invalid for create) and attach taskId for updates.
function createBody(payload: TaskFormPayload) {
  const { recurrence, ...rest } = payload;
  return recurrence ? { ...rest, recurrence } : rest;
}

export function TasksView({
  initialTasks,
  categories,
  members,
  access,
  userId,
  minutesPerPoint,
}: {
  initialTasks: TaskDTO[];
  categories: CategoryDTO[];
  members: MemberDTO[];
  /** The viewer's Tasks access (Members → Permissions). */
  access: PageAccess;
  userId: string;
  /** Household points rate, for the editor's live points. */
  minutesPerPoint: number;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TaskDTO | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskDTO | null>(null);
  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  // A link to one task (?task=<id>, from a notification) opens and
  // highlights it.
  const focusId = searchParams.get('task');
  const [showCompleted, setShowCompleted] = useState(
    () => !!focusId && initialTasks.some((t) => t.id === focusId && t.status === 'completed'),
  );
  const [filters, setFilters] = useState<Filters>({
    status: searchParams.get('status') ?? '',
    type: searchParams.get('type') ?? '',
    assigneeId: searchParams.get('assignee') ?? '',
  });
  const [sort, setSort] = useState<SortKey>(() => {
    const s = searchParams.get('sort');
    return s === 'priority' || s === 'created' ? s : 'due';
  });

  // Mirror filters, sort and search into the URL so filtered views survive
  // navigation and can be bookmarked. Defaults are omitted so a clean /tasks
  // URL stays clean.
  const syncUrl = (nextFilters: Filters, nextSort: SortKey, nextSearch: string) => {
    const params = new URLSearchParams();
    if (nextSearch) params.set('q', nextSearch);
    if (nextFilters.status) params.set('status', nextFilters.status);
    if (nextFilters.type) params.set('type', nextFilters.type);
    if (nextFilters.assigneeId) params.set('assignee', nextFilters.assigneeId);
    if (nextSort !== 'due') params.set('sort', nextSort);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const changeFilters = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    syncUrl(next, sort, search);
  };

  const changeSort = (next: SortKey) => {
    setSort(next);
    syncUrl(filters, next, search);
  };

  // Search updates state on every keystroke but debounces the URL write so
  // typing doesn't spam router.replace.
  useEffect(() => {
    if (search === (searchParams.get('q') ?? '')) return;
    const handle = setTimeout(() => syncUrl(filters, sort, search), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters, sort, searchParams]);

  const tasksKey = ['tasks', filters];

  const {
    data: tasks = [],
    isPending,
    isFetching,
  } = useQuery({
    queryKey: tasksKey,
    queryFn: () => apiFetch<TaskDTO[]>(`/api/tasks${buildQuery(filters)}`),
    initialData:
      !filters.status && !filters.type && !filters.assigneeId
        ? initialTasks
        : undefined,
    // Keep showing the previous list while a filter change refetches.
    placeholderData: keepPreviousData,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  }

  const createMutation = useMutation({
    mutationFn: (payload: TaskFormPayload) =>
      apiFetch<TaskDTO>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(createBody(payload)),
      }),
    onSuccess: () => {
      setShowForm(false);
      toast.success('Task created');
      invalidate();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ taskId, payload }: { taskId: string; payload: TaskFormPayload }) =>
      apiFetch<TaskDTO>('/api/tasks/update', {
        method: 'POST',
        body: JSON.stringify({ taskId, ...payload }),
      }),
    onSuccess: () => {
      setEditing(null);
      toast.success('Task updated');
      invalidate();
    },
  });

  // Deliberately not optimistic: completing a recurring task doesn't flip its
  // status — the server resets it to pending with a recurrence-computed next
  // due date (or finalizes it when the rule has ended), which the client can't
  // predict. The `completingId` spinner covers the wait instead.
  const completeMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiFetch<TaskDTO & { completionId: string }>('/api/tasks/complete', {
        method: 'POST',
        body: JSON.stringify({ taskId }),
      }),
    onMutate: (taskId) => setCompletingId(taskId),
    onSettled: () => setCompletingId(null),
    onSuccess: (task) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['points'] });
      // The completer can take it back for 10 minutes (then only the head).
      toast.success(`Completed “${task.title}”`, {
        label: 'Undo',
        onClick: () => undoMutation.mutate(task.completionId),
      });
    },
  });

  const undoMutation = useMutation({
    mutationFn: (completionId: string) =>
      apiFetch<TaskDTO>('/api/tasks/completions/undo', {
        method: 'POST',
        body: JSON.stringify({ completionId }),
      }),
    onSuccess: () => {
      toast.success('Completion undone; its points were taken back');
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['points'] });
      queryClient.invalidateQueries({ queryKey: ['task-completions'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (taskId: string) =>
      apiFetch<{ id: string }>('/api/tasks/delete', {
        method: 'POST',
        body: JSON.stringify({ taskId }),
      }),
    onMutate: (taskId) => setDeletingId(taskId),
    onSettled: () => setDeletingId(null),
    onSuccess: () => {
      setConfirmDelete(null);
      toast.success('Task deleted');
      invalidate();
    },
  });

  const addSubtaskMutation = useMutation({
    mutationFn: (vars: { taskId: string; title: string }) =>
      apiFetch<TaskDTO>('/api/subtasks', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => invalidate(),
  });

  const toggleSubtaskMutation = useMutation({
    mutationFn: (vars: { subtaskId: string; done: boolean }) =>
      apiFetch<TaskDTO>('/api/subtasks/update', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    // Optimistically flip the checkbox in the currently visible list so it
    // responds instantly; onSettled re-syncs every filter combo either way.
    onMutate: async ({ subtaskId, done }) => {
      await queryClient.cancelQueries({ queryKey: tasksKey });
      const previous = queryClient.getQueryData<TaskDTO[]>(tasksKey);
      queryClient.setQueryData<TaskDTO[]>(tasksKey, (old) =>
        old?.map((task) => ({
          ...task,
          subtasks: task.subtasks.map((s) =>
            s.id === subtaskId ? { ...s, done } : s,
          ),
        })),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(tasksKey, context.previous);
      }
      // A local onError suppresses the global MutationCache toast; re-surface.
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: () => invalidate(),
  });

  const deleteSubtaskMutation = useMutation({
    mutationFn: (subtaskId: string) =>
      apiFetch<TaskDTO>('/api/subtasks/delete', {
        method: 'POST',
        body: JSON.stringify({ subtaskId }),
      }),
    onSuccess: () => invalidate(),
  });

  const editSubtaskMutation = useMutation({
    mutationFn: (vars: {
      subtaskId: string;
      title: string;
      resetIntervalDays: number | null;
    }) =>
      apiFetch<TaskDTO>('/api/subtasks/update', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => invalidate(),
  });

  const reorderSubtasksMutation = useMutation({
    mutationFn: (vars: { taskId: string; subtaskIds: string[] }) =>
      apiFetch<TaskDTO>('/api/subtasks/reorder', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    // Move the row instantly; onSettled re-syncs the true order.
    onMutate: async ({ taskId, subtaskIds }) => {
      await queryClient.cancelQueries({ queryKey: tasksKey });
      const previous = queryClient.getQueryData<TaskDTO[]>(tasksKey);
      const rank = new Map(subtaskIds.map((id, i) => [id, i]));
      queryClient.setQueryData<TaskDTO[]>(tasksKey, (old) =>
        old?.map((task) =>
          task.id === taskId
            ? {
                ...task,
                subtasks: [...task.subtasks]
                  .sort(
                    (a, b) =>
                      (rank.get(a.id) ?? a.position) -
                      (rank.get(b.id) ?? b.position),
                  )
                  .map((s, i) => ({ ...s, position: i })),
              }
            : task,
        ),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(tasksKey, context.previous);
      }
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: () => invalidate(),
  });

  const sorted = useMemo(() => {
    const copy = [...tasks];
    if (sort === 'priority') {
      copy.sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9),
      );
    } else if (sort === 'created') {
      copy.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    // 'due' keeps the server ordering (due date asc, nulls last).
    return copy;
  }, [tasks, sort]);

  // Client-side search over the loaded list; the server filters do the rest.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.notes ?? '').toLowerCase().includes(q),
    );
  }, [sorted, search]);

  const active = visible.filter((t) => t.status !== 'completed');
  const completed = visible.filter((t) => t.status === 'completed');

  const cardHandlers = {
    access,
    userId,
    onComplete: (id: string) => completeMutation.mutate(id),
    onDelete: (id: string) =>
      setConfirmDelete(tasks.find((t) => t.id === id) ?? null),
    onEdit: (task: TaskDTO) => {
      setEditing(task);
      setShowForm(false);
    },
    onToggleSubtask: (subtaskId: string, done: boolean) =>
      toggleSubtaskMutation.mutate({ subtaskId, done }),
    onUndoCompletion: (completionId: string) => undoMutation.mutate(completionId),
    onAddSubtask: (taskId: string, title: string) =>
      addSubtaskMutation.mutate({ taskId, title }),
    onDeleteSubtask: (subtaskId: string) =>
      deleteSubtaskMutation.mutate(subtaskId),
    onEditSubtask: (
      subtaskId: string,
      patch: { title: string; resetIntervalDays: number | null },
    ) => editSubtaskMutation.mutate({ subtaskId, ...patch }),
    onMoveSubtask: (task: TaskDTO, subtaskId: string, direction: -1 | 1) => {
      const ids = task.subtasks.map((s) => s.id);
      const from = ids.indexOf(subtaskId);
      const to = from + direction;
      if (from === -1 || to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      reorderSubtasksMutation.mutate({ taskId: task.id, subtaskIds: ids });
    },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Tasks &amp; Chores</h1>
          <p className="text-sm text-muted-foreground">
            {active.length} active · {completed.length} completed
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Phones have no Points tab in the bottom bar; this is the way in. */}
          <Button variant="outline" onClick={() => router.push('/points')}>
            <Trophy /> Points
          </Button>
          {access.create && !showForm && !editing ? (
            <Button onClick={() => setShowForm(true)}>
              <Plus /> New task
            </Button>
          ) : null}
        </div>
      </div>

      {showForm ? (
        <CreateTaskForm
          categories={categories}
          members={members}
          minutesPerPoint={minutesPerPoint}
          submitting={createMutation.isPending}
          onSubmit={(payload) => createMutation.mutate(payload)}
          onCancel={() => setShowForm(false)}
        />
      ) : null}

      {editing ? (
        // The editor works on a draft of the whole checklist (time/points are
        // split live) and saves it in one go with the task.
        <CreateTaskForm
          key={editing.id}
          categories={categories}
          members={members}
          minutesPerPoint={minutesPerPoint}
          initial={tasks.find((t) => t.id === editing.id) ?? editing}
          submitting={updateMutation.isPending}
          onSubmit={(payload) =>
            updateMutation.mutate({ taskId: editing.id, payload })
          }
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {!showForm && !editing ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="f-search" className="text-xs">
              Search
            </Label>
            <Input
              id="f-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title or notes…"
              className="h-9 w-44"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-status" className="text-xs">
              Status
            </Label>
            <Select
              id="f-status"
              value={filters.status}
              onChange={(e) => changeFilters({ status: e.target.value })}
            >
              <option value="">All active</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-type" className="text-xs">
              Type
            </Label>
            <Select
              id="f-type"
              value={filters.type}
              onChange={(e) => changeFilters({ type: e.target.value })}
            >
              <option value="">All types</option>
              {TASK_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TASK_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-assignee" className="text-xs">
              Assignee
            </Label>
            <Select
              id="f-assignee"
              value={filters.assigneeId}
              onChange={(e) => changeFilters({ assigneeId: e.target.value })}
            >
              <option value="">Anyone</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="f-sort" className="text-xs">
              Sort
            </Label>
            <Select
              id="f-sort"
              value={sort}
              onChange={(e) => changeSort(e.target.value as SortKey)}
            >
              <option value="due">Due date</option>
              <option value="priority">Priority</option>
              <option value="created">Newest</option>
            </Select>
          </div>
          {isFetching ? (
            <Loader2 className="mb-2.5 size-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          'space-y-6 transition-opacity',
          isFetching && 'opacity-60',
        )}
      >
        {!isPending && tasks.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No tasks yet"
            description="Create your first chore or task to get started."
          />
        ) : null}

        {tasks.length > 0 && active.length === 0 && completed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tasks match your search.
          </p>
        ) : null}

        {active.length > 0 ? (
          <div className="space-y-3">
            {active.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                focused={task.id === focusId}
                completing={completingId === task.id}
                deleting={deletingId === task.id}
                {...cardHandlers}
              />
            ))}
          </div>
        ) : null}

        {completed.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setShowCompleted((v) => !v)}
              aria-expanded={showCompleted}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={`size-4 transition-transform ${showCompleted ? '' : '-rotate-90'}`}
              />
              Completed ({completed.length})
            </button>
            {showCompleted ? (
              <div className="mt-3 space-y-3">
                {completed.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    focused={task.id === focusId}
                    completing={false}
                    deleting={deletingId === task.id}
                    {...cardHandlers}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) deleteMutation.mutate(confirmDelete.id);
        }}
        title="Delete task?"
        description={
          confirmDelete
            ? `Delete "${confirmDelete.title}"? Its checklist and completion history will be removed too.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        pending={deleteMutation.isPending}
      />
    </div>
  );
}
