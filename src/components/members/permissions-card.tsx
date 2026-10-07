'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import type { AccessSettingsMatrixDTO } from '@/lib/types';
import { USER_ROLE_LABELS, isUserRole } from '@/lib/enums';
import {
  ACCESS_ACTIONS,
  ACCESS_ACTION_LABELS,
  ACCESS_PAGES,
  ACCESS_PAGE_LABELS,
  EDITABLE_ROLES,
  PAGE_ACTIONS,
  type AccessMatrix,
  type EditableRole,
} from '@/lib/permissions';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';

// The head's editor for page access: each role's default grid, and per-member
// overrides on top of it. Rules live in src/lib/permissions.ts; the server
// enforces them (requireCreate / requireModify), this only edits them.

/** "role:manager" or "member:<id>". */
type Target = `role:${EditableRole}` | `member:${string}`;

function roleLabel(role: string): string {
  return isUserRole(role) ? USER_ROLE_LABELS[role] : role;
}

export function PermissionsCard({ membersVersion }: { membersVersion: string }) {
  const queryClient = useQueryClient();
  const [selected, setTarget] = useState<Target>('role:member');
  // Unsaved edits, tagged with the selection + saved grid they were made on, so
  // switching who you're editing (or a save landing) drops them automatically.
  const [edit, setEdit] = useState<{ key: string; access: AccessMatrix } | null>(null);

  // Adding, removing or re-roling someone changes this list and their grids,
  // so the member roster is part of the key.
  const queryKey = ['permissions', membersVersion];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => apiFetch<AccessSettingsMatrixDTO>('/api/permissions'),
  });

  const member = selected.startsWith('member:')
    ? data?.members.find((m) => m.id === selected.slice('member:'.length))
    : undefined;
  // A member who left (or became head) can't be edited; fall back to a role.
  const target: Target =
    data && selected.startsWith('member:') && !member ? 'role:member' : selected;

  const role: EditableRole | null = target.startsWith('role:')
    ? (target.slice('role:'.length) as EditableRole)
    : member && (EDITABLE_ROLES as readonly string[]).includes(member.role)
      ? (member.role as EditableRole)
      : null;
  const saved: AccessMatrix | null = !data
    ? null
    : member
      ? member.access
      : role
        ? data.roles[role]
        : null;
  // What the member would have with no overrides — highlights their custom cells.
  const roleDefault = member && role && data ? data.roles[role] : null;

  const editKey = `${target}|${JSON.stringify(saved)}`;
  const draft = edit?.key === editKey ? edit.access : saved;

  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useMutation({
    mutationFn: (access: AccessMatrix | null) =>
      member
        ? apiFetch<AccessSettingsMatrixDTO>('/api/permissions/member', {
            method: 'POST',
            body: JSON.stringify({ memberId: member.id, access }),
          })
        : apiFetch<AccessSettingsMatrixDTO>('/api/permissions/role', {
            method: 'POST',
            body: JSON.stringify({ role, access }),
          }),
    onSuccess: (next, access) => {
      queryClient.setQueryData(queryKey, next);
      toast.success(
        access === null
          ? `${member?.name ?? 'Member'} reset to the ${roleLabel(member?.role ?? '')} default`
          : 'Permissions saved',
      );
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save permissions.'),
  });

  function toggle(page: (typeof ACCESS_PAGES)[number], action: (typeof ACCESS_ACTIONS)[number]) {
    if (!draft) return;
    const next = structuredClone(draft);
    next[page][action] = !next[page][action];
    setEdit({ key: editKey, access: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" /> Permissions
        </CardTitle>
        <CardDescription>
          Choose what people can add, edit and delete on each page. “Own” means
          things they added themselves. Set a default for each role, then adjust
          individual members if needed. On Requests, “Add” is submitting a new
          request; people can always edit or delete their own. The Head of House
          can always do everything, and anyone can complete tasks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="permissions-target">Editing</Label>
          <Select
            id="permissions-target"
            value={target}
            onChange={(e) => setTarget(e.target.value as Target)}
            disabled={isLoading}
          >
            <optgroup label="Role defaults">
              {EDITABLE_ROLES.map((r) => (
                <option key={r} value={`role:${r}`}>
                  All {roleLabel(r)}s (default)
                </option>
              ))}
            </optgroup>
            {data && data.members.length > 0 ? (
              <optgroup label="Individual members">
                {data.members.map((m) => (
                  <option key={m.id} value={`member:${m.id}`}>
                    {m.name} ({roleLabel(m.role)}){m.customized ? ' · custom' : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
          <p className="text-xs text-muted-foreground">
            {member
              ? member.customized
                ? `${member.name} has custom permissions. Highlighted boxes differ from the ${roleLabel(member.role)} default.`
                : `${member.name} follows the ${roleLabel(member.role)} default. Changing a box here applies to them only.`
              : role
                ? `Applies to every ${roleLabel(role)} without custom permissions of their own.`
                : null}
          </p>
        </div>

        {!draft ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading permissions…
          </div>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-2 pr-2 text-left font-medium">Page</th>
                  {ACCESS_ACTIONS.map((a) => (
                    <th key={a} className="px-1 py-2 text-center font-medium">
                      {ACCESS_ACTION_LABELS[a]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ACCESS_PAGES.map((p) => (
                  <tr key={p} className="border-t border-border">
                    <th scope="row" className="py-2 pr-2 text-left font-medium">
                      {ACCESS_PAGE_LABELS[p]}
                    </th>
                    {ACCESS_ACTIONS.map((a) => {
                      if (!PAGE_ACTIONS[p].includes(a)) {
                        return (
                          <td key={a} className="px-1 py-2 text-center text-muted-foreground" aria-hidden>
                            —
                          </td>
                        );
                      }
                      const differs = !!roleDefault && draft[p][a] !== roleDefault[p][a];
                      return (
                        <td key={a} className="px-1 py-2 text-center">
                          <label
                            className={cn(
                              'inline-flex size-9 cursor-pointer items-center justify-center rounded-md',
                              differs && 'bg-[var(--color-warning)]/15 ring-1 ring-[var(--color-warning)]',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="size-4 rounded border-input"
                              checked={draft[p][a]}
                              onChange={() => toggle(p, a)}
                              disabled={save.isPending}
                              aria-label={`${ACCESS_PAGE_LABELS[p]}: ${p === 'requests' ? 'Submit' : ACCESS_ACTION_LABELS[a]}`}
                            />
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => draft && save.mutate(draft)}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
          <Button
            variant="ghost"
            onClick={() => setEdit(null)}
            disabled={!dirty || save.isPending}
          >
            Discard changes
          </Button>
          {member?.customized ? (
            <Button
              variant="outline"
              className="ml-auto"
              onClick={() => save.mutate(null)}
              disabled={save.isPending}
            >
              <RotateCcw /> Reset to {roleLabel(member.role)} default
            </Button>
          ) : null}
          {member && !member.customized ? (
            <Badge variant="secondary" className="ml-auto">
              Using {roleLabel(member.role)} default
            </Badge>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
