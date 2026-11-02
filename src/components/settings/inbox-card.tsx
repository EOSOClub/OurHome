'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, Loader2, Mail, Pencil, RefreshCw, Unplug } from 'lucide-react';
import type { InboxSkippedDTO, InboxStatusDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { safeHref } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';
import { toast } from '@/components/ui/toast';
import { useHouseholdZone } from '@/components/household-zone';

const STATUS_KEY = ['inbox-status'];

const OUTCOME_LABELS: Record<string, string> = {
  created: 'new',
  updated: 'updated',
  linked: 'payments recorded',
  duplicate: 'already imported',
  skipped: 'skipped',
  removed: 'removed (no longer a bill)',
  kept: 'kept for you to check',
  withdrawn: 'withdrawn, nothing to remove',
};

const TOKEN_PATTERN = /^ohi_[A-Za-z0-9_-]{43}$/;

/**
 * The household's OurHomeInbox bill import: its connection (the Head of
 * House connects the household's OurHomeInbox here), when it last ran, what it
 * imported, which emails it skipped and why, plus "Check now".
 */
export function InboxCard() {
  const timeZone = useHouseholdZone();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => apiFetch<InboxStatusDTO>('/api/integrations/inbox'),
  });

  const sync = useMutation({
    mutationFn: () => apiFetch<InboxStatusDTO>('/api/integrations/inbox/sync', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      // New bills may have arrived.
      void queryClient.invalidateQueries({ queryKey: ['bills'] });
      toast.success('Checked OurHomeInbox');
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
    <CollapsibleCard
      icon={<Mail className="size-4" />}
      title="OurHomeInbox bill import"
      description={
        <>
          Bill and payment emails read by OurHomeInbox become bills and payments here, checked
          every 15 minutes. OurHomeInbox decides when an email is ready: someone checked it
          there, or its biller is set to send automatically. Payments are matched to an unpaid
          bill; one with no bill to pay is listed below instead.
        </>
      }
      contentClassName="space-y-4"
      // A failed check, or both imports on at once, opens it so it isn't missed.
      openWhen={!!status?.lastError || (!!status?.configured && status.paperlessConnected)}
    >
      {status?.configured && status.paperlessConnected ? (
        <p className="rounded-md border border-[var(--color-warning)] px-3 py-2 text-sm">
          Paperless is connected too. If Paperless also reads your bills email, bills without an
          invoice number come in twice. Turn off Paperless&apos;s mail rules for that email, or
          disconnect Paperless if you no longer use it.
        </p>
      ) : null}
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
                  Connected since {new Date(status.since).toLocaleDateString(undefined, { timeZone })}.
                  Emails from before the start date set in OurHomeInbox never come in.
                </p>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Check now
            </Button>
          </div>

          {status.lastError ? (
            <p className="rounded-md border border-[var(--color-warning)] px-3 py-2 text-sm">{status.lastError}</p>
          ) : null}

          {result ? (
            <p className="text-sm text-muted-foreground">
              Last check: {result.checked} email(s) from OurHomeInbox
              {counts.length ? ` · ${counts.join(' · ')}` : ''}.
            </p>
          ) : null}

          {result?.skipped.length ? (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Skipped recently</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {result.skipped.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.title}</p>
                      <p className="text-xs text-muted-foreground">{s.reason}</p>
                    </div>
                    <SkippedLink item={s} />
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Fix a value on the email in OurHomeInbox and it comes in on the next check. For a
                payment with no bill, add the bill here and record the payment on it.
              </p>
            </div>
          ) : null}
        </>
      )}
    </CollapsibleCard>
  );
}

/** A bill kept here opens in OurHome; an email opens in OurHomeInbox. */
function SkippedLink({ item }: { item: InboxSkippedDTO }) {
  if (item.url?.startsWith('/bills/')) {
    return (
      <Link
        href={item.url}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={`Open the bill ${item.title}`}
        title="Open the bill"
      >
        <ArrowRight className="size-4" />
      </Link>
    );
  }
  const href = safeHref(item.url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={`Open the email ${item.title} in OurHomeInbox`}
      title="Open the email in OurHomeInbox"
    >
      <ExternalLink className="size-4" />
    </a>
  );
}

/**
 * Where the import reads from, and (Head of House) the form to connect,
 * change or disconnect the household's OurHomeInbox. The token is never
 * shown again once saved; leaving it blank keeps it.
 */
function ConnectionSection({ status }: { status: InboxStatusDTO }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const conn = status.connection;

  const disconnect = useMutation({
    mutationFn: () => apiFetch<InboxStatusDTO>('/api/integrations/inbox/disconnect', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      toast.success('OurHomeInbox disconnected. Bills it brought in stay.');
    },
  });

  if (!conn && !status.canEdit) {
    return (
      <p className="text-sm text-muted-foreground">
        Not connected. Your Head of House can connect your household&apos;s OurHomeInbox here.
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
        {conn!.remoteHousehold ? (
          <p className="truncate text-xs text-muted-foreground">
            OurHomeInbox household: {conn!.remoteHousehold}
          </p>
        ) : null}
      </div>
      {status.canEdit ? (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil /> Change
          </Button>
          <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            <Unplug /> Disconnect
          </Button>
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
  status: InboxStatusDTO;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const own = status.connection;
  const [url, setUrl] = useState(own?.url ?? '');
  const [publicUrl, setPublicUrl] = useState(own?.publicUrl ?? '');
  const [token, setToken] = useState('');
  const fe = useFieldErrors('ohi');

  const save = useMutation({
    mutationFn: () =>
      apiFetch<InboxStatusDTO>('/api/integrations/inbox', {
        method: 'PUT',
        body: JSON.stringify({ url: url.trim(), publicUrl: publicUrl.trim(), token: token.trim() || null }),
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(STATUS_KEY, next);
      toast.success('OurHomeInbox connected. Emails it has ready come in on the next check.');
      setToken('');
      onDone();
    },
    // Says why ("Couldn't use that OurHomeInbox: …", or which field is wrong) and marks it.
    onError: fe.fail,
  });

  const urlLooksRight = /^https?:\/\/\S+$/i.test(url.trim());
  const tokenLooksRight = TOKEN_PATTERN.test(token.trim());
  const canSave = urlLooksRight && (tokenLooksRight || (!!own && !token.trim())) && !save.isPending;
  // OurHomeInbox is usually reached over plain HTTP on the Docker network.
  // noinspection HttpUrlsUsage
  const urlError =
    fe.get('url') ?? (url.trim() && !urlLooksRight ? 'Start with http:// or https://, with no spaces.' : null);
  const tokenError =
    fe.get('token') ??
    (token.trim() && !tokenLooksRight ? 'Paste the whole token from OurHomeInbox: it starts with ohi_.' : null);

  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save.mutate();
      }}
      {...fe.formProps}
    >
      <p className="text-sm font-medium">{own ? 'Change your OurHomeInbox' : 'Connect your OurHomeInbox'}</p>
      <div className="space-y-1.5" data-field="url">
        <Label htmlFor="ohi-url">OurHomeInbox address</Label>
        <Input
          id="ohi-url"
          placeholder={status.privateNetworkAllowed ? 'http://ourhome_inbox:8080' : 'https://inbox.example.com'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={urlError ? true : undefined}
          aria-describedby={fe.noteId('url')}
        />
        <FieldNote
          id={fe.noteId('url')}
          error={urlError}
          hint={
            status.privateNetworkAllowed
              ? 'How this server reaches it: a Docker or home-network address works.'
              : 'Must be a public internet address. To use one on this server’s own network, ask the server admin to allow it.'
          }
        />
      </div>
      <div className="space-y-1.5" data-field="publicUrl">
        <Label htmlFor="ohi-public">Address you open it at (optional)</Label>
        <Input
          id="ohi-public"
          placeholder="https://inbox.example.com"
          value={publicUrl}
          onChange={(e) => setPublicUrl(e.target.value)}
          {...fe.invalid('publicUrl')}
        />
        <FieldNote
          id={fe.noteId('publicUrl')}
          error={fe.get('publicUrl')}
          hint="For “Open the email” links on bills and on skipped emails."
        />
      </div>
      <div className="space-y-1.5" data-field="token">
        <Label htmlFor="ohi-token">Token</Label>
        <Input
          id="ohi-token"
          type="password"
          autoComplete="off"
          placeholder={own ? 'Leave blank to keep the saved token' : 'ohi_…'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={tokenError ? true : undefined}
          aria-describedby={fe.noteId('token')}
        />
        <FieldNote
          id={fe.noteId('token')}
          error={tokenError}
          hint="Make it in OurHomeInbox: Settings, OurHome connection, Create a token. It is shown only once there. Stored encrypted here. Saving checks the connection first."
        />
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
