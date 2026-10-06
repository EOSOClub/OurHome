'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { NotificationDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type NotificationList = {
  items: NotificationDTO[];
  unreadCount: number;
  hasMore: boolean;
};

export const NOTIFICATIONS_KEY = ['notifications'] as const;

export function NotificationBell() {
  const { data } = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: () => apiFetch<NotificationList>('/api/notifications'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const unread = data?.unreadCount ?? 0;

  return (
    <Link
      href="/notifications"
      aria-label={
        unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'
      }
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'icon' }),
        'relative text-muted-foreground hover:text-foreground',
      )}
    >
      <Bell />
      {unread > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  );
}
