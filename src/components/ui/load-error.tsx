'use client';

import { AlertCircle, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Shown when data failed to load, in place of the list or form it feeds.
 * Without it a failed load looked like an empty list, or spun forever.
 */
export function LoadError({
  message = "Couldn't load this. Check your connection and try again.",
  onRetry,
  retrying = false,
}: {
  message?: string;
  /** Usually the query's refetch. */
  onRetry: () => void;
  /** True while the retry is running (the query's isFetching). */
  retrying?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 px-4 py-6 text-center"
    >
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" onClick={onRetry} disabled={retrying}>
        {retrying ? <Loader2 className="animate-spin" /> : <RotateCw />}
        Try again
      </Button>
    </div>
  );
}
