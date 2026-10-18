'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Smartphone } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { UsageHistoryDTO } from '@/lib/types';
import { USAGE_KEEP_DAYS } from '@/lib/appUsage';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UsageHistory } from '@/components/look-after/usage-history';

// Tells a child or teen, on their own Profile, that an adult who looks after
// them shares their app usage (appUsageService), and shows them the same
// numbers the adult sees. Nothing shows otherwise.
export function AppUsageNotice() {
  const { data } = useQuery({
    queryKey: ['my-usage-sharing'],
    queryFn: () => apiFetch<{ shared: boolean }>('/api/phone/usage'),
  });
  const shared = data?.shared === true;
  const history = useQuery({
    queryKey: ['my-usage-history'],
    queryFn: () => apiFetch<UsageHistoryDTO>('/api/phone/usage/history'),
    enabled: shared,
  });
  if (!shared) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-5" /> Your app usage is shared
        </CardTitle>
        <CardDescription>
          An adult who looks after you turned this on, and only they can turn it off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0 text-sm text-muted-foreground">
        <p>
          The OurHome app on your phone sends how long you spend in each app, about every 15 minutes. You and the
          adults who look after you can see it, and only the last {USAGE_KEEP_DAYS} days are kept. They&apos;re also
          told when you install a new app. Nothing is blocked or limited.
        </p>
        <p>
          For it to work, the app needs <strong>Usage access</strong>: the app shows you how to allow it, under
          Profile on your phone.
        </p>
        <div className="rounded-lg border border-border p-3 text-foreground">
          {history.isPending ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : history.isError ? (
            <p className="text-xs text-destructive">Couldn&apos;t load your app usage.</p>
          ) : (
            <UsageHistory history={history.data} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
