'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Loader2, Pencil, RefreshCw, Unplug } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { useHouseholdZone } from '@/components/household-zone';

const STATUS_KEY = ['paperless-status'];

const OUTCOME_LABELS: Record<string, string> = {
  created: 'new',
  updated: 'updated',
  linked: 'payments recorded',
  duplicate: 'already imported',
  skipped: 'skipped',
};

/**
 * The household's Paperless bill import: its connection (the Head of House
 * connects the household's own Paperless here), when it last ran, what it
 * imported, which documents it skipped and why, plus "Check now".
 */
export function PaperlessCard() {
  const timeZone = useHouseholdZone();
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
        {status ? <ConnectionSection status={status} /> : null}
        {!status ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !status.configured ? null : (
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
                      ? `Last checked ${new Date(status.lastRunAt).toLocaleString(undefined, { timeZone })}`
                      : 'Not checked yet'}
                  </span>
                </p>
                {status.since ? (
                  <p className="text-xs text-muted-foreground">
                    Importing documents changed since {new Date(status.since).toLocaleDateString(undefined, { timeZone })}.
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

/**
 * Where the import reads from, and (Head of House) the form to connect,
 * change or disconnect the household's own Paperless. The token is never
 * shown again once saved; leaving it blank keeps it.
 */
function ConnectionSection({ status }: { status: PaperlessStatusDTO }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const conn = status.connection;

  const disconnect = useMutation({
    mutationFn: () => apiFetch<PaperlessStatusDTO>('/api/integrations/paperless/disconnect', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      toast.success('Paperless disconnected');
    },
  });

  if (!conn && !status.canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        Not connected. Your Head of House can connect your household&apos;s Paperless here.
      </p>
    );
  }

  if (editing || (!conn && status.canEdit)) {
    return (
      <ConnectionForm
        status={status}
        onDone={() => setEditing(false)}
        onCancel={conn ? () => setEditing(false) : undefined}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 text-sm">
        <p className="truncate">
          <span className="text-muted-foreground">Connected to</span> <code>{conn!.url}</code>
        </p>
        {conn!.source === 'server' ? (
          <p className="text-xs text-muted-foreground">
            From the server&apos;s settings. Connect your own to replace it.
          </p>
        ) : null}
      </div>
      {status.canEdit ? (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> {conn!.source === 'server' ? 'Connect your own' : 'Change'}
          </Button>
          {conn!.source === 'household' ? (
            <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              <Unplug /> Disconnect
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionForm({
  status,
  onDone,
  onCancel,
}: {
  status: PaperlessStatusDTO;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const own = status.connection?.source === 'household' ? status.connection : null;
  const [url, setUrl] = useState(own?.url ?? '');
  const [publicUrl, setPublicUrl] = useState(own?.publicUrl ?? '');
  const [token, setToken] = useState('');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<PaperlessStatusDTO>('/api/integrations/paperless', {
        method: 'PUT',
        body: JSON.stringify({ url: url.trim(), publicUrl: publicUrl.trim(), token: token.trim() || null }),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      toast.success('Paperless connected. Bills changed from now on will be imported.');
      setToken('');
      onDone();
    },
    // "Couldn't use that Paperless: …" comes from the global mutation toast.
  });

  const canSave = /^https?:\/\/\S+$/i.test(url.trim()) && (token.trim().length > 0 || !!own) && !save.isPending;

  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save.mutate();
      }}
    >
      <p className="text-sm font-medium">{own ? 'Change your Paperless' : 'Connect your Paperless'}</p>
      <div className="space-y-1.5">
        <Label htmlFor="pl-url">Paperless address</Label>
        <Input
          id="pl-url"
          placeholder={status.privateNetworkAllowed ? 'http://paperless:8000' : 'https://paperless.example.com'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {status.privateNetworkAllowed
            ? 'How this server reaches it: a Docker or home-network address works.'
            : 'Must be a public internet address. To use one on this server’s own network, ask the server admin to allow it.'}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pl-public">Address you open it at (optional)</Label>
        <Input
          id="pl-public"
          placeholder="https://paperless.example.com"
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">For “Open in Paperless” links on skipped documents.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pl-token">API token</Label>
        <Input
          id="pl-token"
          type="password"
          autoComplete="off"
          placeholder={own ? 'Leave blank to keep the saved token' : ''}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Of a read-only Paperless user that can see the <code>bill</code> / <code>bill-payment</code> tags and
          the Amount field. Stored encrypted. Saving checks the connection first.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {own ? 'Save' : 'Connect'}
        </Button>
      </div>
    </form>
  );
}
