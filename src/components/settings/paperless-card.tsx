'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import type { PaperlessStatusDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { safeHref } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

const STATUS_KEY = ['paperless-status'];

const OUTCOME_LABELS: Record<string, string> = {
  created: 'new',
  updated: 'updated',
  linked: 'payments recorded',
  duplicate: 'already imported',
  skipped: 'skipped',
};

/**
 * Status of the Paperless bill import: when it last ran, what it imported,
 * which documents it skipped and why, plus "Check now". The import itself is
 * configured on the server (PAPERLESS_URL / PAPERLESS_TOKEN).
 */
export function PaperlessCard() {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<PaperlessStatusDTO>('/api/integrations/paperless'),
  });

  const sync = useMutation({
    mutationFn: () =>
      apiFetch<PaperlessStatusDTO>('/api/integrations/paperless/sync', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      // New bills may have arrived.
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      toast.success('Checked Paperless');
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
    // The error message itself comes from the global mutation-error toast.
  });

  const result = status?.lastResult;
  const counts = result
    ? Object.entries(result.imported)
        .filter(([, n]) => n)
        .map(([k, n]) => `${n} ${OUTCOME_LABELS[k] ?? k}`)
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4" /> Paperless bill import
        </CardTitle>
        <CardDescription>
          Documents tagged <code>bill</code> or <code>bill-payment</code> in Paperless-ngx
          become bills and payments here, checked every 15 minutes. Payments are matched to an
          unpaid bill; one with no bill to pay is listed below instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">
            Not set up. Set <code>paperless.url</code> in the server&apos;s{' '}
            <code>settings.yml</code> and <code>PAPERLESS_TOKEN</code> in its{' '}
            <code>.env</code>, then restart. See <code>docs/paperless-import.md</code>.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1 text-sm">
                <p>
                  {status.lastError ? (
                    <Badge variant="warning">Last check failed</Badge>
                  ) : (
                    <Badge variant="success">Connected</Badge>
                  )}{' '}
                  <span className="text-muted-foreground">
                    {status.lastRunAt
                      ? `Last checked ${new Date(status.lastRunAt).toLocaleString()}`
                      : 'Not checked yet'}
                  </span>
                </p>
                {status.since ? (
                  <p className="text-xs text-muted-foreground">
                    Importing documents changed since {new Date(status.since).toLocaleDateString()}.
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
              >
                {sync.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Check now
              </Button>
            </div>

            {status.lastError ? (
              <p className="rounded-md border border-[var(--color-warning)] px-3 py-2 text-sm">
                {status.lastError}
              </p>
            ) : null}

            {result ? (
              <p className="text-sm text-muted-foreground">
                Last check: {result.checked} document(s) changed
                {counts.length ? ` · ${counts.join(' · ')}` : ''}.
              </p>
            ) : null}

            {result?.skipped.length ? (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Skipped recently
                </p>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {result.skipped.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{s.title}</p>
                        <p className="text-xs text-muted-foreground">{s.reason}</p>
                      </div>
                      {safeHref(s.url) ? (
                        <a
                          href={safeHref(s.url)}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          title="Open in Paperless"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">
                  Fix the document in Paperless (add the Amount, finish the review, or add the
                  bill first) and it is picked up on the next check.
                </p>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
