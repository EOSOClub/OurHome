'use client';

import { useQuery } from '@tanstack/react-query';
import { Smartphone } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { USAGE_KEEP_DAYS } from '@/lib/appUsage';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

// Tells a child or teen, on their own Profile, that an adult who looks after
// them shares their app usage (appUsageService). Nothing shows otherwise.
export function AppUsageNotice() {
  const { data } = useQuery({
    queryKey: ['my-usage-sharing'],
    queryFn: () => apiFetch<{ shared: boolean }>('/api/phone/usage'),
  });
  if (!data?.shared) return null;
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
      <CardContent className="space-y-2 pt-0 text-sm text-muted-foreground">
        <p>
          The OurHome app on your phone sends how long you spend in each app, about every 15 minutes. Only the adults
          who look after you can see it, and only the last {USAGE_KEEP_DAYS} days are kept. Nothing is blocked or
          limited.
        </p>
        <p>
          For it to work, the app needs <strong>Usage access</strong>: the app shows you how to allow it, under
          Profile on your phone.
        </p>
      </CardContent>
    </Card>
  );
}
