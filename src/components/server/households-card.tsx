'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Loader2, Network, Plus, Power, Trash2, Upload } from 'lucide-react';
import type { HouseholdSummaryDTO } from '@/server/services/serverAdminService';
import { apiFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useHouseholdZone } from '@/components/household-zone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';

const KEY = ['server', 'households'] as const;

/**
 * Every household on this server (server admin). Creating one makes its Head
 * of House with a temporary password; that person then adds their own
 * members. The admin never sees inside other households.
 */
export function HouseholdsCard({ initial }: { initial: HouseholdSummaryDTO[] }) {
  const queryClient = useQueryClient();
  const timeZone = useHouseholdZone();
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [resetting, setResetting] = useState<HouseholdSummaryDTO | null>(null);
  const [turningOff, setTurningOff] = useState<HouseholdSummaryDTO | null>(null);
  const [deleting, setDeleting] = useState<HouseholdSummaryDTO | null>(null);

  const { data: households = initial } = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<HouseholdSummaryDTO[]>('/api/server/households'),
    initialData: initial,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });

  const setDisabled = useMutation({
    mutationFn: (vars: { id: string; disabled: boolean }) =>
      apiFetch('/api/server/households/disable', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_d, vars) => {
      toast.success(vars.disabled ? 'Household turned off' : 'Household turned on');
      setTurningOff(null);
      invalidate();
    },
  });

  const setPaperlessNetwork = useMutation({
    mutationFn: (vars: { id: string; allowed: boolean }) =>
      apiFetch('/api/server/households/paperless-network', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (_d, vars) => {
      toast.success(
        vars.allowed
          ? 'Its Paperless may now be on this server’s network'
          : 'Its Paperless must now be a public address',
      );
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-4" /> Households
          </CardTitle>
          <CardDescription>
            Each household is separate: its members see only their own data. You create a
            household and its Head of House; they add everyone else.
          </CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setRestoring(true)}>
            <Upload /> Restore from export
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New household
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {households.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {h.name}
                  {h.isOwn ? <Badge variant="secondary">Yours</Badge> : null}
                  {h.disabled ? <Badge variant="destructive">Turned off</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    h.head ? `Head: ${h.head.name}${h.head.username ? ` (@${h.head.username})` : ''}` : 'No Head of House',
                    `${h.members} member${h.members === 1 ? '' : 's'}`,
                    `created ${formatDate(h.createdAt, timeZone)}`,
                    h.lastActivityAt ? `last active ${formatDate(h.lastActivityAt, timeZone)}` : 'no activity yet',
                  ].join(' · ')}
                </p>
                <p className="text-xs text-muted-foreground">
                  Paperless: {h.hasPaperless ? 'connected' : 'not connected'} ·{' '}
                  {h.paperlessPrivateNetwork ? 'may use this server’s network' : 'public addresses only'}
                </p>
              </div>
              {!h.isOwn ? (
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setPaperlessNetwork.isPending}
                    title="Whether this household's Paperless may be on this server's private network (Docker, LAN). Only allow households you trust."
                    onClick={() => setPaperlessNetwork.mutate({ id: h.id, allowed: !h.paperlessPrivateNetwork })}
                  >
                    <Network /> {h.paperlessPrivateNetwork ? 'Paperless: public only' : 'Paperless: allow local'}
                  </Button>
                  {h.head ? (
                    <Button variant="ghost" size="sm" onClick={() => setResetting(h)}>
                      <KeyRound /> Reset head’s password
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={setDisabled.isPending}
                    onClick={() =>
                      h.disabled ? setDisabled.mutate({ id: h.id, disabled: false }) : setTurningOff(h)
                    }
                  >
                    <Power /> {h.disabled ? 'Turn on' : 'Turn off'}
                  </Button>
                  {h.disabled ? (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(h)}>
                      <Trash2 /> Delete
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>

      {creating ? (
        <CreateHouseholdDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            invalidate();
          }}
        />
      ) : null}
      {resetting ? <ResetHeadDialog household={resetting} onClose={() => setResetting(null)} /> : null}
      {restoring ? (
        <RestoreHouseholdDialog
          onClose={() => setRestoring(false)}
          onRestored={invalidate}
        />
      ) : null}
      {deleting ? (
        <DeleteHouseholdDialog
          household={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            invalidate();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!turningOff}
        title={`Turn off “${turningOff?.name ?? ''}”?`}
        description="Its members are signed out and can't use the site or app until you turn it back on. Nothing is deleted."
        confirmLabel="Turn off"
        destructive
        pending={setDisabled.isPending}
        onConfirm={() => turningOff && setDisabled.mutate({ id: turningOff.id, disabled: true })}
        onClose={() => setTurningOff(null)}
      />
    </Card>
  );
}

function CreateHouseholdDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [householdName, setHouseholdName] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const create = useMutation({
    mutationFn: () =>
      apiFetch<HouseholdSummaryDTO>('/api/server/households', {
        method: 'POST',
        body: JSON.stringify({
          householdName: householdName.trim(),
          head: {
            name: name.trim(),
            username: username.trim(),
            email: email.trim() || undefined,
            password,
          },
        }),
      }),
    onSuccess: (h) => {
      toast.success(`Created “${h.name}”. Give ${name.trim()} their username and temporary password.`);
      onCreated();
    },
    // Errors (e.g. username taken) surface via the global mutation toast.
  });

  const valid =
    householdName.trim().length > 0 &&
    name.trim().length > 0 &&
    /^[a-zA-Z0-9._-]{3,30}$/.test(username.trim()) &&
    password.length >= 8;

  return (
    <Dialog open onClose={onClose} title="New household">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !create.isPending) create.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="hh-name">Household name</Label>
          <Input id="hh-name" autoFocus value={householdName} onChange={(e) => setHouseholdName(e.target.value)} />
        </div>
        <p className="text-sm font-medium">Head of House</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="hh-head-name">Name</Label>
            <Input id="hh-head-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="hh-head-username">Username</Label>
            <Input
              id="hh-head-username"
              value={username}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="hh-head-email">Email (optional, for password resets)</Label>
            <Input id="hh-head-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="hh-head-password">Temporary password</Label>
            <Input
              id="hh-head-password"
              type="text"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least 8 characters. They must choose their own the first time they sign in.
              Usernames are unique across the whole server.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || create.isPending}>
            {create.isPending ? <Loader2 className="animate-spin" /> : null}
            Create household
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetHeadDialog({ household, onClose }: { household: HouseholdSummaryDTO; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const reset = useMutation({
    mutationFn: () =>
      apiFetch('/api/server/households/reset-head-password', {
        method: 'POST',
        body: JSON.stringify({ id: household.id, password }),
      }),
    onSuccess: () => {
      toast.success(`Password reset. ${household.head?.name ?? 'They'} must choose a new one at sign-in.`);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Reset ${household.head?.name ?? 'head'}’s password`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length >= 8 && !reset.isPending) reset.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="reset-head-password">Temporary password</Label>
          <Input
            id="reset-head-password"
            autoFocus
            type="text"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            They’re signed out everywhere and must choose their own password at next sign-in.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={password.length < 8 || reset.isPending}>
            {reset.isPending ? <Loader2 className="animate-spin" /> : null}
            Reset password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Delete for good: only for a household that's turned off, with its name
 * typed to confirm. Its members' accounts go too. The admin can't export
 * another household's data (they don't see inside it), so the dialog says to
 * have its Head of House export first.
 */
function DeleteHouseholdDialog({
  household,
  onClose,
  onDeleted,
}: {
  household: HouseholdSummaryDTO;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () =>
      apiFetch('/api/server/households/delete', {
        method: 'POST',
        body: JSON.stringify({ id: household.id, confirmName: typed }),
      }),
    onSuccess: () => {
      toast.success(`Deleted “${household.name}”`);
      onDeleted();
    },
  });
  const matches = typed.trim() === household.name.trim();
  return (
    <Dialog open onClose={onClose} title={`Delete “${household.name}”?`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !remove.isPending) remove.mutate();
        }}
      >
        <div className="space-y-2 text-sm">
          <p>
            This permanently deletes the household and everything in it: its{' '}
            {household.members} member account{household.members === 1 ? '' : 's'}, tasks and points,
            bills, shopping, stock, requests, calendar and activity. It can’t be undone.
          </p>
          <p className="text-muted-foreground">
            Want a copy first? Turn it back on and ask its Head of House to use Settings → Export
            household data.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="delete-household-name">Type the household’s name to confirm</Label>
          <Input
            id="delete-household-name"
            autoFocus
            autoComplete="off"
            value={typed}
            placeholder={household.name}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!matches || remove.isPending}>
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
            Delete forever
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface ExportPreview {
  data: unknown;
  name: string;
  members: number;
  head: string | null;
  exportedAt: string | null;
}

interface RestoreReport {
  householdId: string;
  name: string;
  headUsername: string;
  counts: Record<string, number>;
  notes: string[];
}

/** Read an export file in the browser and summarise it before restoring. */
function previewExport(text: string): ExportPreview {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data?.format !== 'ourhome-household-export') throw new Error('That file isn’t an Our Home household export.');
  const household = (data.household ?? {}) as { name?: string };
  const members = Array.isArray(data.members) ? (data.members as { role?: string; username?: string }[]) : [];
  return {
    data,
    name: household.name ?? 'Household',
    members: members.length,
    head: members.find((m) => m.role === 'head')?.username ?? null,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
  };
}

/**
 * Restore a household from an export file as a new household. Everything in
 * the file comes back with new ids; the head gets the temporary password set
 * here and gives the others theirs from Members.
 */
function RestoreHouseholdDialog({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const timeZone = useHouseholdZone();
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [report, setReport] = useState<RestoreReport | null>(null);

  const restore = useMutation({
    mutationFn: () =>
      apiFetch<RestoreReport>('/api/server/households/restore', {
        method: 'POST',
        body: JSON.stringify({ data: preview!.data, name: name.trim(), headPassword: password }),
      }),
    onSuccess: (r) => {
      setReport(r);
      onRestored();
    },
    // Clashing usernames etc. come from the global mutation toast.
  });

  async function pickFile(file: File | undefined) {
    setPreview(null);
    setFileError(null);
    if (!file) return;
    try {
      const p = previewExport(await file.text());
      setPreview(p);
      setName(p.name);
    } catch (err) {
      setFileError(err instanceof SyntaxError ? 'That file isn’t valid JSON.' : (err as Error).message);
    }
  }

  if (report) {
    const total = Object.values(report.counts).reduce((a, n) => a + n, 0);
    return (
      <Dialog open onClose={onClose} title={`Restored “${report.name}”`}>
        <div className="space-y-3 text-sm">
          <p>
            {total} records restored. Its Head of House signs in as <strong>@{report.headUsername}</strong> with the
            temporary password you set, and must choose a new one.
          </p>
          {report.notes.length ? (
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const valid = !!preview && name.trim().length > 0 && password.length >= 8;
  return (
    <Dialog open onClose={onClose} title="Restore a household">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !restore.isPending) restore.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="restore-file">Export file</Label>
          <Input
            id="restore-file"
            type="file"
            accept="application/json,.json"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
          <p className="text-xs text-muted-foreground">
            The JSON file from Settings → Export household data. It comes back as a new household; nothing on
            this server is changed or replaced.
          </p>
          {fileError ? <p className="text-xs text-destructive">{fileError}</p> : null}
        </div>
        {preview ? (
          <>
            <p className="rounded-md border border-border px-3 py-2 text-sm">
              <strong>{preview.name}</strong> · {preview.members} member{preview.members === 1 ? '' : 's'}
              {preview.head ? ` · head @${preview.head}` : ''}
              {preview.exportedAt ? ` · exported ${formatDate(preview.exportedAt, timeZone)}` : ''}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="restore-name">Household name</Label>
              <Input id="restore-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="restore-password">Temporary password for the Head of House</Label>
              <Input
                id="restore-password"
                type="text"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                At least 8 characters; they choose their own at first sign-in. Exports hold no passwords, so the
                other members get theirs from the head (Members → Reset password).
              </p>
            </div>
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || restore.isPending}>
            {restore.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            Restore
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
