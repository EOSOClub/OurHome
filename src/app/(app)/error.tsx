'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Segment-level error boundary for routes under (app). `unstable_retry`
 * re-fetches and re-renders the failed segment (this Next.js version's
 * recommended recovery over plain `reset`).
 */
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card className="mx-auto mt-10 max-w-md">
      <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </span>
        <p className="text-sm font-medium">Something went wrong</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          An unexpected error occurred while loading this page.
        </p>
        <Button size="sm" onClick={() => unstable_retry()}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
