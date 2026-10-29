'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { SupervisionDTO } from '@/lib/types';
import { USER_ROLE_LABELS, isUserRole } from '@/lib/enums';
import { apiFetch, ApiError } from '@/lib/api';
import { toast } from '@/components/ui/toast';

// The head's supervision list (parental controls): which adults supervise
// each child and teen. Chosen when a child or teen is added (Add a member)
// and changed later on their row. Rules live in src/lib/permissions.ts
// (canSupervise / canBeSupervised); the server enforces them, this only
// edits the list.

/** What every supervisor picker says: only the ticked adults get the controls. */
export const SUPERVISION_HINT =
  'Only the adults ticked here can change their phone rules and get alerts about their phone. Only the Head of House can change this, so nobody can add themselves.';

function roleLabel(role: string): string {
  return isUserRole(role) ? USER_ROLE_LABELS[role] : role;
}

/** The supervision list, for the Head of House only ([enabled]). */
export function useSupervision(membersVersion: string, enabled: boolean) {
  // Adding, removing, renaming or changing someone's role changes who appears here.
  const queryKey = ['supervision', membersVersion];
  const query = useQuery({
    queryKey,
    queryFn: () => apiFetch<SupervisionDTO>('/api/supervision'),
    enabled,
    // Keep showing the list while a roster change refetches it.
    placeholderData: keepPreviousData,
  });
  return { data: query.data, queryKey };
}

/** "Supervised by Alex, Sam", or a nudge when nobody is. */
export function supervisedByText(
  supervisorIds: string[],
  supervisors: SupervisionDTO['supervisors'],
): string {
  const names = supervisors.filter((s) => supervisorIds.includes(s.id)).map((s) => s.name);
  return names.length ? `Supervised by ${names.join(', ')}` : 'Nobody supervises them yet';
}

/** One tick box per adult who may supervise. */
export function SupervisorChecks({
  supervisors,
  checked,
  disabled,
  kidName,
  onToggle,
}: {
  supervisors: SupervisionDTO['supervisors'];
  checked: string[];
  disabled?: boolean;
  kidName: string;
  onToggle: (id: string) => void;
}) {
  if (supervisors.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody in the household can supervise yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {supervisors.map((s) => (
        <label
          key={s.id}
          className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10"
        >
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={checked.includes(s.id)}
            disabled={disabled}
            onChange={() => onToggle(s.id)}
            aria-label={`${s.name} supervises ${kidName}`}
          />
          {s.name}
          <span className="text-xs text-muted-foreground">{roleLabel(s.role)}</span>
        </label>
      ))}
    </div>
  );
}

/** Toggles [id] in [list]. */
export function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((s) => s !== id) : [...list, id];
}

/** On a child's or teen's row: who supervises them, saved with each tick. */
export function MemberSupervisors({
  kid,
  supervisors,
  queryKey,
}: {
  kid: SupervisionDTO['supervised'][number];
  supervisors: SupervisionDTO['supervisors'];
  queryKey: unknown[];
}) {
  const queryClient = useQueryClient();

  const save = useMutation({
    mutationFn: (supervisorIds: string[]) =>
      apiFetch<SupervisionDTO>('/api/supervision', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: kid.id, supervisorIds }),
      }),
    onSuccess: (next) => {
      // Set before the pending state ends, so the boxes never flick back.
      queryClient.setQueryData(queryKey, next);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not save who supervises them.'),
  });

  // While saving, show the boxes as they're being saved.
  const checked = save.isPending && save.variables ? save.variables : kid.supervisorIds;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Who supervises them</p>
        {save.isPending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </div>
      <SupervisorChecks
        supervisors={supervisors}
        checked={checked}
        disabled={save.isPending}
        kidName={kid.name}
        onToggle={(id) => save.mutate(toggled(checked, id))}
      />
      <p className="text-xs text-muted-foreground">{SUPERVISION_HINT}</p>
    </div>
  );
}
