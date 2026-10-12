'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Baby, Loader2 } from 'lucide-react';
import type { SupervisionDTO } from '@/lib/types';
import { USER_ROLE_LABELS, isUserRole } from '@/lib/enums';
import { apiFetch, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

// The head's supervision list (parental controls): which adults supervise
// each child and teen. Rules live in src/lib/permissions.ts (canSupervise /
// canBeSupervised); the server enforces them, this only edits the list.

function roleLabel(role: string): string {
  return isUserRole(role) ? USER_ROLE_LABELS[role] : role;
}

export function SupervisionCard({ membersVersion }: { membersVersion: string }) {
  // Adding, removing or re-roling someone changes who appears here.
  const queryKey = ['supervision', membersVersion];
  const { data } = useQuery({
    queryKey,
    queryFn: () => apiFetch<SupervisionDTO>('/api/supervision'),
    // Keep showing the list while a roster change refetches it.
    placeholderData: keepPreviousData,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Baby className="size-5" /> Supervision
        </CardTitle>
        <CardDescription>
          Choose which adults look after each child and teen. Parental
          controls will use this list: only the adults ticked here will be
          able to change that child’s phone rules and get alerts about their
          phone. Only you can change it, so nobody can add themselves.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : data.supervised.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody in the household is a Child or Teen yet. Give someone one of
            those roles above and they’ll appear here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.supervised.map((kid) => (
              <SupervisedRow
                key={kid.id}
                kid={kid}
                supervisors={data.supervisors}
                queryKey={queryKey}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SupervisedRow({
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

  function toggle(id: string) {
    save.mutate(checked.includes(id) ? checked.filter((s) => s !== id) : [...checked, id]);
  }

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{kid.name}</p>
        <Badge variant="secondary">{roleLabel(kid.role)}</Badge>
        {save.isPending ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : checked.length === 0 ? (
          <span className="text-xs text-muted-foreground">Nobody supervises them yet</span>
        ) : null}
      </div>
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
              disabled={save.isPending}
              onChange={() => toggle(s.id)}
              aria-label={`${s.name} supervises ${kid.name}`}
            />
            {s.name}
            <span className="text-xs text-muted-foreground">{roleLabel(s.role)}</span>
          </label>
        ))}
      </div>
    </li>
  );
}
