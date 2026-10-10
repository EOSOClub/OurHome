'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Bell,
  Bug,
  CheckCheck,
  Info,
  Loader2,
  Package,
  Receipt,
  Clock,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDTO } from '@/lib/types';
import {
  NOTIFICATION_TYPE_LABELS,
  type NotificationType,
} from '@/lib/enums';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';

import {
  NOTIFICATIONS_KEY,
  type NotificationList,
} from '@/components/notifications/notification-bell';
import { RelativeTime } from '@/components/household-zone';

const TYPE_ICON: Record<NotificationType, LucideIcon> = {
  overdue: AlertTriangle,
  low_inventory: Package,
  reminder: Clock,
  bill_due: Receipt,
  system: Info,
  bug_report: Bug,
  task_ready: ListChecks,
};

const TYPE_VARIANT: Record<
  NotificationType,
  'default' | 'secondary' | 'destructive' | 'warning'
> = {
  overdue: 'destructive',
  low_inventory: 'warning',
  reminder: 'default',
  bill_due: 'warning',
  system: 'secondary',
  bug_report: 'destructive',
  task_ready: 'default',
};

type ReadFilter = 'all' | 'unread' | 'read';

const READ_FILTERS: { value: ReadFilter; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
  { value: 'all', label: 'All' },
];

/**
 * Where a notification's subject lives, from ActivityEntry-style subject types
 * (see the writers in src/server/services/reminderService.ts). Tasks open on
 * the task itself. Unknown types get no link.
 */
function subjectHref(n: NotificationDTO): string | null {
  switch (n.subjectType) {
    case 'task':
      return n.subjectId ? `/tasks?task=${encodeURIComponent(n.subjectId)}` : '/tasks';
    case 'request':
      return '/requests';
    case 'event':
      return '/calendar';
    case 'household':
      return '/settings';
    case 'bill':
      return n.subjectId ? `/bills/${n.subjectId}` : '/bills';
    case 'inventory_item':
    case 'inventory':
      return '/inventory';
    case 'shopping':
    case 'shopping_item':
    case 'shopping_list':
      return '/shopping';
    case 'app_release':
      return '/profile';
    default:
      return null;
  }
}

export function NotificationsView({ initial }: { initial: NotificationList }) {
  const queryClient = useQueryClient();
  // The bell is a to-do list: opening a notification marks it read, so it
  // leaves this (default) view. "Read" keeps the history.
  const [filter, setFilter] = useState<ReadFilter>('unread');

  // Older pages loaded via "Load more" live outside the shared query cache so
  // the bell's badge query and the optimistic patches keep their small,
  // first-page-only shape. `olderHasMore` is null until an older page loads;
  // before that, the base query's hasMore decides whether the button shows.
  const [older, setOlder] = useState<NotificationDTO[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => apiFetch<NotificationList>('/api/notifications'),
    initialData: initial,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });

  const markOne = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ updated: number }>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
    // Optimistically mark it read — the bell shares this cache, so its badge
    // updates instantly too; onSettled re-syncs with the server either way.
    // The row may live in the cached first page or a locally loaded older
    // page, so patch (and roll back) both.
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const previous =
        queryClient.getQueryData<NotificationList>(NOTIFICATIONS_KEY);
      const previousOlder = older;
      const wasUnread =
        previous?.items.some((n) => n.id === id && !n.read) ||
        older.some((n) => n.id === id && !n.read);
      queryClient.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((n) =>
                n.id === id ? { ...n, read: true } : n,
              ),
              unreadCount: wasUnread
                ? Math.max(0, old.unreadCount - 1)
                : old.unreadCount,
            }
          : old,
      );
      setOlder((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      return { previous, previousOlder };
    },
    onError: (error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(NOTIFICATIONS_KEY, context.previous);
      }
      if (context?.previousOlder) setOlder(context.previousOlder);
      // A local onError suppresses the global MutationCache toast; re-surface.
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: invalidate,
  });

  const markAll = useMutation({
    mutationFn: () =>
      apiFetch<{ updated: number }>('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: NOTIFICATIONS_KEY });
      const previous =
        queryClient.getQueryData<NotificationList>(NOTIFICATIONS_KEY);
      const previousOlder = older;
      queryClient.setQueryData<NotificationList>(NOTIFICATIONS_KEY, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((n) => (n.read ? n : { ...n, read: true })),
              unreadCount: 0,
            }
          : old,
      );
      setOlder((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
      return { previous, previousOlder };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(NOTIFICATIONS_KEY, context.previous);
      }
      if (context?.previousOlder) setOlder(context.previousOlder);
      // A local onError suppresses the global MutationCache toast; re-surface.
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: invalidate,
  });

  const unread = data?.unreadCount ?? 0;

  // First page (cache) + accumulated older pages. Refetches can shift the
  // first-page window into already-loaded rows, so drop duplicates by id
  // (the cached copy wins — it is fresher).
  const seen = new Set<string>();
  const items = [...(data?.items ?? []), ...older].filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
  const visible = items.filter((n) =>
    filter === 'all' ? true : filter === 'read' ? n.read : !n.read,
  );
  const hasMore = olderHasMore ?? data?.hasMore ?? false;

  const loadMore = async () => {
    const oldest = items[items.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiFetch<NotificationList>(
        `/api/notifications?before=${oldest.id}`,
      );
      setOlder((prev) => [...prev, ...page.items]);
      setOlderHasMore(page.hasMore);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Open one to go to it; it then clears from here.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => markAll.mutate()}
          disabled={unread === 0 || markAll.isPending}
        >
          {markAll.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CheckCheck />
          )}
          Mark all read
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={Bell}
              title="You’re all caught up"
              description="Reminders for overdue tasks and low inventory will appear here."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div
            role="group"
            aria-label="Filter notifications"
            className="inline-flex gap-1 rounded-lg border border-border bg-card p-1"
          >
            {READ_FILTERS.map((f) => (
              <Button
                key={f.value}
                type="button"
                variant={filter === f.value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
                {f.value === 'unread' && unread > 0 ? ` (${unread})` : ''}
              </Button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {filter === 'unread' ? 'You’re all caught up.' : `No ${filter} notifications.`}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {visible.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onMarkRead={() => markOne.mutate(n.id)}
                  marking={markOne.isPending && markOne.variables === n.id}
                />
              ))}
            </ul>
          )}

          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                Load more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function NotificationRow({
  notification: n,
  onMarkRead,
  marking,
}: {
  notification: NotificationDTO;
  onMarkRead: () => void;
  marking: boolean;
}) {
  const type = n.type as NotificationType;
  const Icon = TYPE_ICON[type] ?? Info;
  const href = subjectHref(n);

  const body = (
    <>
      <div className="flex items-center gap-2">
        <p
          className={
            'truncate text-sm font-medium' +
            (href ? ' group-hover:underline' : '')
          }
        >
          {n.title}
        </p>
        {!n.read ? (
          <span
            className="size-2 shrink-0 rounded-full bg-primary"
            aria-label="Unread"
          />
        ) : null}
      </div>
      {n.body ? (
        <p className="text-sm text-muted-foreground">{n.body}</p>
      ) : null}
      <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={TYPE_VARIANT[type] ?? 'secondary'}>
          {NOTIFICATION_TYPE_LABELS[type] ?? n.type}
        </Badge>
        <RelativeTime date={n.createdAt} />
      </p>
    </>
  );

  return (
    <li
      className={
        'flex items-start gap-3 px-4 py-3 ' + (n.read ? 'opacity-60' : '')
      }
    >
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      {href ? (
        <Link
          href={href}
          className="group min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            // Mark read in the background; don't block navigation.
            if (!n.read) onMarkRead();
          }}
        >
          {body}
        </Link>
      ) : (
        // Nothing to open: tapping it just clears it.
        <button
          type="button"
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (!n.read) onMarkRead();
          }}
        >
          {body}
        </button>
      )}
      {!n.read ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onMarkRead}
          disabled={marking}
        >
          Mark read
        </Button>
      ) : null}
    </li>
  );
}
