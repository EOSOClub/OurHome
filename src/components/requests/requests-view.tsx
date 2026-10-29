'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  Film,
  Hand,
  Inbox,
  Loader2,
  Pencil,
  ShoppingCart,
  Trash2,
  TriangleAlert,
  Tv,
  UserRoundPen,
  Wrench,
  X,
} from 'lucide-react';
import type { MemberDTO, RequestDTO } from '@/lib/types';
import {
  DECISION_STATUS_LABELS,
  MAINTENANCE_STATUSES,
  MAINTENANCE_STATUS_LABELS,
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  MEDIA_STATUS_LABELS,
  MEDIA_TYPE_SECTION_LABELS,
  REQUEST_CATEGORY_LABELS,
  type MediaType,
  type RequestCategory,
  type RequestStatus,
} from '@/lib/enums';
import { viewDecides, type RequestModuleView } from '@/lib/requestModules';
import { ItemLink } from '@/components/shopping/shopping-item-row';
import { LinkField } from '@/components/shopping/link-field';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
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
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors, type FieldErrorsState } from '@/lib/use-field-errors';
import { EmptyState } from '@/components/empty-state';
import { useHouseholdZone } from '@/components/household-zone';
import { isOverdue } from '@/lib/format';

export type RequestPayload =
  | {
      category: 'media';
      mediaType: MediaType;
      title: string;
      year: number;
      season: number | null;
      /** A problem with something the household already has. */
      issue: boolean;
      episode: number | null;
      /** A problem report's "what's wrong". */
      details: string | null;
    }
  | {
      category: 'maintenance';
      title: string;
      details: string | null;
      assigneeId: string;
    }
  | {
      category: 'purchase';
      title: string;
      /** Why. */
      details: string | null;
      url: string | null;
      imageUrl: string | null;
      /** Estimated price of one. */
      price: number | null;
      quantity: number | null;
    }
  | {
      category: 'permission';
      title: string;
      details: string | null;
      startsAt: string | null;
      endsAt: string | null;
    };

const MEDIA_ICONS: Record<MediaType, typeof Film> = { movie: Film, tv: Tv };

/** Yes-or-no kinds, shown in this order above Maintenance and Media. */
const DECISION_KINDS = ['permission', 'purchase'] as const;
const CATEGORY_ICONS: Record<RequestCategory, typeof Film> = {
  media: Film,
  maintenance: Wrench,
  purchase: ShoppingCart,
  permission: Hand,
};
const DECISION_SECTIONS = [
  ['pending', 'Waiting for a decision'],
  ['completed', 'Approved'],
  ['declined', 'Declined'],
] as const;

// In the household's zone, so the server render and the browser agree.
const shortDate = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone });

/** "Fri, Oct 24, 6:00 PM" in the household's zone. */
const shortDateTime = (iso: string, timeZone?: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });

/** A permission's from and until: "Fri, Oct 24, 6:00 PM until Sat, Oct 25, 11:00 AM". */
const whenLabel = (r: { startsAt: string | null; endsAt: string | null }, timeZone?: string) =>
  r.startsAt
    ? `${shortDateTime(r.startsAt, timeZone)}${r.endsAt ? ` until ${shortDateTime(r.endsAt, timeZone)}` : ''}`
    : null;

/** An ISO time → a datetime-local value ("YYYY-MM-DDTHH:mm") in this browser's time. */
const localInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const money = (n: number) => `$${n.toFixed(2)}`;

/** A date-input value ("YYYY-MM-DD") → noon local, matching the other forms. */
const noonIso = (date: string) => new Date(`${date}T12:00`).toISOString();

/** Today as a date-input value in local time. */
const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function RequestsView({
  initialRequests,
  initialModules,
  currentUserId,
  isHead,
  members,
}: {
  initialRequests: RequestDTO[];
  /**
   * The kinds of request that are on (Settings → Request types), as this
   * member sees them: which they may ask for (with the Requests "Add" switch)
   * and which they handle.
   */
  initialModules: RequestModuleView[];
  currentUserId: string;
  /** The head may reassign or remove anyone's maintenance request. */
  isHead: boolean;
  members: MemberDTO[];
}) {
  const timeZone = useHouseholdZone();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RequestDTO | null>(null);
  const [accepting, setAccepting] = useState<RequestDTO | null>(null);
  // A purchase being approved, where the approver may put it on a shopping list.
  const [approving, setApproving] = useState<RequestDTO | null>(null);
  const [declining, setDeclining] = useState<RequestDTO | null>(null);
  // A maintenance request the head is giving to someone else.
  const [reassigning, setReassigning] = useState<RequestDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RequestDTO | null>(null);
  // Bumped after a request is created so the form remounts empty.
  const [formKey, setFormKey] = useState(0);

  const { data: requests = [] } = useQuery({
    queryKey: ['requests'],
    queryFn: () => apiFetch<RequestDTO[]>('/api/requests'),
    initialData: initialRequests,
  });

  const { data: modules = [] } = useQuery({
    queryKey: ['request-modules'],
    queryFn: () => apiFetch<RequestModuleView[]>('/api/requests/modules'),
    initialData: initialModules,
  });
  const mediaModule = modules.find((m) => m.id === 'media');
  const maintenanceModule = modules.find((m) => m.id === 'maintenance');
  const purchaseModule = modules.find((m) => m.id === 'purchase');
  const canSubmit = modules.some((m) => m.canAsk);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['requests'] });
  const post = <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });

  // Each form's field errors: the new-request card, the edit dialog, the accept date, the decline reason.
  const createForm = useFieldErrors('request-new');
  const editForm = useFieldErrors('request-edit');
  const acceptForm = useFieldErrors('request-accept');
  const declineForm = useFieldErrors('request-decline');
  const reassignForm = useFieldErrors('request-reassign');

  const createMutation = useMutation({
    mutationFn: (payload: RequestPayload) => post<RequestDTO>('/api/requests', payload),
    onSuccess: (r) => {
      toast.success(
        r.category === 'maintenance'
          ? `Sent to ${r.assignee?.name ?? 'them'}`
          : r.issue
            ? `Reported a problem with “${r.title}”`
            : r.category === 'permission'
              ? `Asked permission for “${r.title}”`
              : `Requested “${r.title}”`,
      );
      setFormKey((k) => k + 1);
      void invalidate();
    },
    onError: createForm.fail,
  });

  const updateMutation = useMutation({
    mutationFn: (payload: RequestPayload & { id: string }) =>
      post<RequestDTO>('/api/requests/update', payload),
    onSuccess: () => {
      toast.success('Request updated');
      setEditing(null);
      void invalidate();
    },
    onError: editForm.fail,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => post<{ id: string }>('/api/requests/delete', { id }),
    onSuccess: () => {
      toast.success('Request removed');
      setConfirmDelete(null);
      void invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Maintenance only: the assignee picks a done-by date (or none, where the
  // head made it optional). Media is marked added in one step (completeMutation).
  const acceptMutation = useMutation({
    mutationFn: (input: { id: string; dueAt?: string }) => post<RequestDTO>('/api/requests/accept', input),
    onSuccess: (r) => {
      toast.success(r.dueAt ? `Done by ${shortDate(r.dueAt, timeZone)} - got it` : `Accepted “${r.title}”`);
      setAccepting(null);
      void invalidate();
    },
    onError: acceptForm.fail,
  });

  // A purchase may go on a shopping list as it's approved (`listId`).
  const completeMutation = useMutation({
    mutationFn: (input: { id: string; listId?: string | null }) => post<RequestDTO>('/api/requests/complete', input),
    onSuccess: (r) => {
      toast.success(
        r.issue
          ? `Marked “${r.title}” fixed`
          : r.category === 'media'
            ? `Added “${r.title}”`
            : r.category === 'purchase' || r.category === 'permission'
              ? `Approved “${r.title}”${r.addedToList ? ` and added it to ${r.addedToList}` : ''}`
              : `Marked “${r.title}” done`,
      );
      setApproving(null);
      void invalidate();
      // It may be on a shopping list now.
      if (r.addedToList) void queryClient.invalidateQueries({ queryKey: ['shopping-lists'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Where the head allows it, whoever handles media, or the person a maintenance
  // request went to, can say no, with a reason.
  const declineMutation = useMutation({
    mutationFn: (input: { id: string; reply: string | null }) => post<RequestDTO>('/api/requests/decline', input),
    onSuccess: (r) => {
      toast.success(`Declined “${r.title}”`);
      setDeclining(null);
      void invalidate();
    },
    onError: declineForm.fail,
  });

  const reassignMutation = useMutation({
    mutationFn: (input: { id: string; assigneeId: string }) => post<RequestDTO>('/api/requests/reassign', input),
    onSuccess: (r) => {
      toast.success(`Sent to ${r.assignee?.name ?? 'them'}`);
      setReassigning(null);
      void invalidate();
    },
    onError: reassignForm.fail,
  });

  const busyId = acceptMutation.isPending
    ? acceptMutation.variables?.id
    : completeMutation.isPending
      ? completeMutation.variables?.id
      : undefined;

  // The server only sends requests of kinds that are on.
  const media = mediaModule ? requests.filter((r) => r.category === 'media') : [];
  const maintenance = maintenanceModule ? requests.filter((r) => r.category === 'maintenance') : [];
  // Problems with what the household already has get their own list, above the requests to add.
  const mediaIssues = media.filter((r) => r.issue);

  const mediaRow = (r: RequestDTO, mod: RequestModuleView) => (
    <MediaRow
      key={r.id}
      request={r}
      isOwn={r.requester.id === currentUserId}
      canManage={mod.handles}
      canDecline={mod.handles && mod.allowDecline}
      currentUserId={currentUserId}
      busy={busyId === r.id}
      onComplete={() => completeMutation.mutate({ id: r.id })}
      onDecline={() => {
        declineForm.clear();
        setDeclining(r);
      }}
      onEdit={() => {
        editForm.clear();
        setEditing(r);
      }}
      onDelete={() => setConfirmDelete(r)}
    />
  );

  const decisionRow = (r: RequestDTO, mod: RequestModuleView) => (
    <DecisionRow
      key={r.id}
      request={r}
      currentUserId={currentUserId}
      decides={viewDecides(mod, r.requester.id)}
      busy={busyId === r.id}
      onApprove={() =>
        // A purchase can go on a shopping list: ask which. Otherwise, approve at once.
        r.category === 'purchase' && mod.shoppingLists.length > 0
          ? setApproving(r)
          : completeMutation.mutate({ id: r.id })
      }
      onDecline={() => {
        declineForm.clear();
        setDeclining(r);
      }}
      onEdit={() => {
        editForm.clear();
        setEditing(r);
      }}
      onDelete={() => setConfirmDelete(r)}
    />
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Requests</h1>
        <p className="text-sm text-muted-foreground">
          Ask the household for something. Everyone can see every request.
        </p>
      </div>

      {canSubmit ? (
        <Card>
          <CardHeader>
            <CardTitle>New request</CardTitle>
            <CardDescription>Pick what you&apos;re requesting, then fill in the details.</CardDescription>
          </CardHeader>
          <CardContent>
            <RequestForm
              key={formKey}
              modules={modules}
              members={members}
              submitLabel="Request"
              pending={createMutation.isPending}
              errors={createForm}
              onSubmit={(payload) => createMutation.mutate(payload)}
            />
          </CardContent>
        </Card>
      ) : null}

      {modules.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No request types are on"
          description="The Head of House chooses them in Settings → Request types."
        />
      ) : requests.length === 0 ? (
        <EmptyState icon={Inbox} title="No requests yet" description="Requests you and your household make show up here." />
      ) : null}

      {DECISION_KINDS.map((kind) => {
        const mod = modules.find((m) => m.id === kind);
        const items = mod ? requests.filter((r) => r.category === kind) : [];
        if (!mod || items.length === 0) return null;
        return (
          <section key={kind} className="space-y-4">
            <CategoryHeader category={kind} label={mod.label} />
            {DECISION_SECTIONS.map(([status, label]) => {
              // Anything still open (no status, or "accepted" from an older app) waits for a decision.
              const group = items.filter((r) =>
                status === 'pending' ? r.status !== 'completed' && r.status !== 'declined' : r.status === status,
              );
              if (group.length === 0) return null;
              return (
                <div key={status} className="space-y-2">
                  <SectionHeader label={label} count={group.length} />
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {group.map((r) => decisionRow(r, mod))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}

      {maintenanceModule && maintenance.length > 0 ? (
        <section className="space-y-4">
          <CategoryHeader category="maintenance" label={maintenanceModule.label} />
          {MAINTENANCE_STATUSES.map((status) => {
            const items = maintenance
              .filter((r) => r.status === status)
              .sort(status === 'accepted' ? byDueDate : () => 0);
            if (items.length === 0) return null;
            return (
              <div key={status} className="space-y-2">
                <SectionHeader label={MAINTENANCE_STATUS_LABELS[status]} count={items.length} />
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {items.map((r) => (
                    <MaintenanceRow
                      key={r.id}
                      request={r}
                      currentUserId={currentUserId}
                      isHead={isHead}
                      requireDueDate={maintenanceModule.requireDueDate}
                      canDecline={maintenanceModule.allowDecline}
                      busy={busyId === r.id}
                      onReassign={() => {
                        reassignForm.clear();
                        setReassigning(r);
                      }}
                      onAccept={() => {
                        acceptForm.clear();
                        setAccepting(r);
                      }}
                      onComplete={() => completeMutation.mutate({ id: r.id })}
                      onDecline={() => {
                        declineForm.clear();
                        setDeclining(r);
                      }}
                      onEdit={() => {
                        editForm.clear();
                        setEditing(r);
                      }}
                      onDelete={() => setConfirmDelete(r)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ) : null}

      {mediaModule && media.length > 0 ? (
        <section className="space-y-4">
          <CategoryHeader category="media" label={mediaModule.label} />
          {mediaIssues.length > 0 ? (
            <div className="space-y-2">
              <SectionHeader label="Problems" count={mediaIssues.length} icon={TriangleAlert} />
              <ul className="divide-y divide-border rounded-lg border border-border">
                {mediaIssues.map((r) => mediaRow(r, mediaModule))}
              </ul>
            </div>
          ) : null}
          {MEDIA_TYPES.map((type) => {
            const items = media.filter((r) => r.mediaType === type && !r.issue);
            // A kind the head stopped offering still shows while it has requests.
            if (items.length === 0 && !mediaModule.mediaTypes.includes(type)) return null;
            const Icon = MEDIA_ICONS[type];
            return (
              <div key={type} className="space-y-2">
                <SectionHeader label={MEDIA_TYPE_SECTION_LABELS[type]} count={items.length} icon={Icon} />
                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No {MEDIA_TYPE_SECTION_LABELS[type].toLowerCase()} requested yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {items.map((r) => mediaRow(r, mediaModule))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title="Edit request">
        {editing ? (
          <RequestForm
            key={editing.id}
            initial={editing}
            modules={modules}
            members={members}
            submitLabel="Save changes"
            pending={updateMutation.isPending}
            errors={editForm}
            onCancel={() => setEditing(null)}
            onSubmit={(payload) => updateMutation.mutate({ ...payload, id: editing.id })}
          />
        ) : null}
      </Dialog>

      <AcceptDialog
        // A fresh date box for each request (it isn't cleared on Accept, so a refused date stays to fix).
        key={accepting?.id ?? 'none'}
        request={accepting}
        requireDueDate={maintenanceModule?.requireDueDate ?? true}
        pending={acceptMutation.isPending}
        errors={acceptForm}
        onClose={() => setAccepting(null)}
        onAccept={(dueAt) =>
          accepting && acceptMutation.mutate(dueAt ? { id: accepting.id, dueAt } : { id: accepting.id })
        }
      />

      <ApproveDialog
        key={approving?.id ?? 'none-approve'}
        request={approving}
        lists={purchaseModule?.shoppingLists ?? []}
        pending={completeMutation.isPending}
        onClose={() => setApproving(null)}
        onApprove={(listId) => approving && completeMutation.mutate({ id: approving.id, listId })}
      />

      <DeclineDialog
        key={declining?.id ?? 'none-decline'}
        request={declining}
        pending={declineMutation.isPending}
        errors={declineForm}
        onClose={() => setDeclining(null)}
        onDecline={(reply) => declining && declineMutation.mutate({ id: declining.id, reply })}
      />

      <ReassignDialog
        key={reassigning?.id ?? 'none-reassign'}
        request={reassigning}
        members={members}
        pending={reassignMutation.isPending}
        errors={reassignForm}
        onClose={() => setReassigning(null)}
        onReassign={(assigneeId) => reassigning && reassignMutation.mutate({ id: reassigning.id, assigneeId })}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}
        title="Remove this request?"
        description={confirmDelete ? `“${confirmDelete.title}” will be removed for everyone.` : undefined}
        confirmLabel="Remove"
        destructive
        pending={deleteMutation.isPending}
      />
    </div>
  );
}

function byDueDate(a: RequestDTO, b: RequestDTO) {
  return (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
}

/** `label`: the head's name for it (Settings → Request types). */
function CategoryHeader({ category, label }: { category: RequestCategory; label: string }) {
  const Icon = CATEGORY_ICONS[category];
  return (
    <h2 className="flex items-center gap-2 border-b border-border pb-1 text-lg font-semibold">
      <Icon className="size-5" /> {label}
    </h2>
  );
}

function SectionHeader({ label, count, icon: Icon }: { label: string; count: number; icon?: typeof Film }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
      {Icon ? <Icon className="size-4" /> : null} {label}
      <span className="font-normal normal-case">({count})</span>
    </h3>
  );
}

function OwnerActions({ title, onEdit, onDelete }: { title: string; onEdit: () => void; onDelete: () => void }) {
  return (
    <>
      <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit ${title}`}>
        <Pencil className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Remove ${title}`}>
        <Trash2 className="size-4" />
      </Button>
    </>
  );
}

// `accepted` is never shown for media (folded into pending) but keeps the Record total.
const MEDIA_STATUS_BADGE: Record<RequestStatus, 'secondary' | 'default' | 'success' | 'destructive'> = {
  pending: 'secondary',
  accepted: 'default',
  completed: 'success',
  declined: 'destructive',
};

function MediaRow({
  request: r,
  isOwn,
  canManage,
  canDecline,
  currentUserId,
  busy,
  onComplete,
  onDecline,
  onEdit,
  onDelete,
}: {
  request: RequestDTO;
  isOwn: boolean;
  /** Handles media: marks it added. */
  canManage: boolean;
  /** Handles media and the head allows declining. */
  canDecline: boolean;
  currentUserId: string;
  busy: boolean;
  onComplete: () => void;
  onDecline: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const timeZone = useHouseholdZone();
  // Requests from before statuses existed have none, and "accepted" is left
  // over from the older accept → available flow: both are still waiting.
  const status: RequestStatus = r.status === 'completed' || r.status === 'declined' ? r.status : 'pending';
  const decider = r.decidedBy ? (r.decidedBy.id === currentUserId ? 'you' : r.decidedBy.name) : null;
  // Problems are listed together, so each says what kind of media it is.
  const Icon = r.issue ? (MEDIA_ICONS[r.mediaType as MediaType] ?? null) : null;
  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center', canManage && status === 'pending' && 'bg-primary/5')}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={MEDIA_TYPE_LABELS[r.mediaType as MediaType]} /> : null}
          <span className={cn('truncate', status === 'declined' && 'text-muted-foreground')}>
            {r.title} <span className="font-normal text-muted-foreground">({r.year})</span>
          </span>
          {r.season ? (
            <Badge variant="outline">
              Season {r.season}
              {r.episode ? ` · Episode ${r.episode}` : null}
            </Badge>
          ) : r.issue && r.mediaType === 'tv' ? (
            <Badge variant="outline">Whole show</Badge>
          ) : null}
          <Badge variant={MEDIA_STATUS_BADGE[status]}>
            {r.issue && status === 'completed' ? 'Fixed' : MEDIA_STATUS_LABELS[status]}
          </Badge>
        </p>
        {r.issue && r.details ? <p className="text-sm text-muted-foreground">{r.details}</p> : null}
        {status === 'declined' ? (
          <p className="text-sm text-muted-foreground">
            {decider ? `Declined by ${decider}` : 'Declined'}
            {r.reply ? `: ${r.reply}` : null}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {r.issue ? 'Reported' : 'Requested'} by {isOwn ? 'you' : r.requester.name} · {shortDate(r.createdAt, timeZone)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {canDecline && status === 'pending' ? (
          <Button size="sm" variant="ghost" onClick={onDecline} disabled={busy}>
            <X /> Decline
          </Button>
        ) : null}
        {canManage && status === 'pending' ? (
          <Button size="sm" onClick={onComplete} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} {r.issue ? 'Mark fixed' : 'Mark as added'}
          </Button>
        ) : null}
        {/* A declined request can't be edited, only removed. */}
        {isOwn && status === 'declined' ? (
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Remove ${r.title}`}>
            <Trash2 className="size-4" />
          </Button>
        ) : isOwn ? (
          <OwnerActions title={r.title} onEdit={onEdit} onDelete={onDelete} />
        ) : null}
      </div>
    </li>
  );
}

function MaintenanceRow({
  request: r,
  currentUserId,
  isHead,
  requireDueDate,
  canDecline,
  busy,
  onReassign,
  onAccept,
  onComplete,
  onDecline,
  onEdit,
  onDelete,
}: {
  request: RequestDTO;
  currentUserId: string;
  /** Reassigns or removes anyone's request. */
  isHead: boolean;
  /** Accepting needs a done-by date (Settings → Request types). */
  requireDueDate: boolean;
  /** The head lets the person asked decline (Settings → Request types). */
  canDecline: boolean;
  busy: boolean;
  onReassign: () => void;
  onAccept: () => void;
  onComplete: () => void;
  onDecline: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const timeZone = useHouseholdZone();
  const isRequester = r.requester.id === currentUserId;
  const isAssignee = r.assignee?.id === currentUserId;
  // On their own request the head has the requester's edit and remove.
  const headActions = isHead && !isRequester;
  const open = r.status === 'pending' || r.status === 'accepted';
  const overdue = r.status === 'accepted' && isOverdue(r.dueAt, timeZone);
  const who = (m: { id: string; name: string } | null) =>
    !m ? 'someone' : m.id === currentUserId ? 'you' : m.name;

  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center', isAssignee && r.status === 'pending' && 'bg-primary/5')}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span
            className={cn(
              'truncate',
              r.status === 'completed' && 'text-muted-foreground line-through',
              r.status === 'declined' && 'text-muted-foreground',
            )}
          >
            {r.title}
          </span>
          {r.status === 'accepted' && r.dueAt ? (
            <Badge variant={overdue ? 'destructive' : 'default'}>
              <CalendarClock className="size-3" /> {overdue ? 'Overdue · ' : 'Done by '}
              {shortDate(r.dueAt, timeZone)}
            </Badge>
          ) : null}
          {r.status === 'completed' && r.completedAt ? (
            <Badge variant="success">Done {shortDate(r.completedAt, timeZone)}</Badge>
          ) : null}
        </p>
        {r.details ? <p className="text-sm text-muted-foreground">{r.details}</p> : null}
        {r.status === 'declined' ? (
          <p className="text-sm text-muted-foreground">
            {r.decidedBy ? `Declined by ${who(r.decidedBy)}` : 'Declined'}
            {r.reply ? `: ${r.reply}` : null}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {isRequester ? 'You' : who(r.requester)} asked {who(r.assignee)} · {shortDate(r.createdAt, timeZone)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {isAssignee && canDecline && open ? (
          <Button size="sm" variant="ghost" onClick={onDecline} disabled={busy}>
            <X /> Decline
          </Button>
        ) : null}
        {isAssignee && r.status === 'pending' ? (
          <Button size="sm" onClick={onAccept}>
            Accept
          </Button>
        ) : null}
        {isAssignee && r.status === 'accepted' ? (
          <>
            {/* Accepted without a date (the head made it optional): one can still be set. */}
            <Button size="sm" variant="ghost" onClick={onAccept}>
              {r.dueAt || requireDueDate ? 'Change date' : 'Set a date'}
            </Button>
            <Button size="sm" variant="outline" onClick={onComplete} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Mark done
            </Button>
          </>
        ) : null}
        {/* A declined request can't be edited, only removed. */}
        {isRequester && r.status === 'declined' ? (
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Remove ${r.title}`}>
            <Trash2 className="size-4" />
          </Button>
        ) : isRequester ? (
          <OwnerActions title={r.title} onEdit={onEdit} onDelete={onDelete} />
        ) : null}
        {headActions && open ? (
          <Button size="sm" variant="ghost" onClick={onReassign} disabled={busy}>
            <UserRoundPen /> Reassign
          </Button>
        ) : null}
        {headActions ? (
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Remove ${r.title}`}>
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** The head gives a maintenance request to someone else: anyone but the requester. */
function ReassignDialog({
  request,
  members,
  pending,
  errors,
  onClose,
  onReassign,
}: {
  request: RequestDTO | null;
  members: MemberDTO[];
  pending: boolean;
  /** The last try's field errors: a refused person is marked with why. */
  errors: FieldErrorsState;
  onClose: () => void;
  onReassign: (assigneeId: string) => void;
}) {
  const [assigneeId, setAssigneeId] = useState(request?.assignee?.id ?? '');
  const choices = members.filter((m) => m.id !== request?.requester.id);
  const unchanged = !assigneeId || assigneeId === request?.assignee?.id;
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title="Reassign request"
      description={request ? `“${request.title}” from ${request.requester.name}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={pending || unchanged} onClick={() => onReassign(assigneeId)}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Reassign
          </Button>
        </>
      }
    >
      <div className="space-y-1.5" data-field="assigneeId" {...errors.formProps}>
        <Label htmlFor="request-reassign-to">Who should do it?</Label>
        <Select
          id="request-reassign-to"
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          {...errors.invalid('assigneeId')}
        >
          <option value="" disabled>
            Choose someone…
          </option>
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
        <FieldNote
          id={errors.noteId('assigneeId')}
          error={errors.get('assigneeId')}
          hint="It goes back to waiting, for them to accept with their own date."
        />
      </div>
    </Dialog>
  );
}

const DECISION_BADGE: Record<RequestStatus, 'secondary' | 'default' | 'success' | 'destructive'> = {
  pending: 'secondary',
  accepted: 'secondary',
  completed: 'success',
  declined: 'destructive',
};

/**
 * A purchase or permission request: what's asked, the decision once made, and
 * Approve / Decline for whoever decides it (`decides`: viewDecides).
 */
function DecisionRow({
  request: r,
  currentUserId,
  decides,
  busy,
  onApprove,
  onDecline,
  onEdit,
  onDelete,
}: {
  request: RequestDTO;
  currentUserId: string;
  decides: boolean;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const timeZone = useHouseholdZone();
  const status: RequestStatus = r.status === 'completed' || r.status === 'declined' ? r.status : 'pending';
  const open = status === 'pending';
  const isOwn = r.requester.id === currentUserId;
  const who = (m: { id: string; name: string } | null) => (!m ? 'someone' : m.id === currentUserId ? 'you' : m.name);
  const when = r.category === 'permission' ? whenLabel(r, timeZone) : null;
  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center', decides && open && 'bg-primary/5')}>
      {r.imageUrl ? (
        // Remote product picture from any shop: a plain <img>, as on Shopping.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={r.imageUrl}
          alt=""
          className="size-12 shrink-0 rounded border border-border bg-white object-contain"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className={cn('min-w-0 break-words', status === 'declined' && 'text-muted-foreground')}>
            {r.quantity && r.quantity > 1 ? `${r.quantity} × ` : null}
            {r.title}
          </span>
          {r.price != null ? (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {money(r.price)}
              {r.quantity && r.quantity > 1 ? ' each' : null}
            </span>
          ) : null}
          <Badge variant={DECISION_BADGE[status]}>{DECISION_STATUS_LABELS[status]}</Badge>
        </p>
        {when ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CalendarClock className="size-3.5 shrink-0" /> {when}
          </p>
        ) : null}
        {r.url ? <ItemLink url={r.url} /> : null}
        {r.details ? <p className="text-sm text-muted-foreground">{r.details}</p> : null}
        {status === 'completed' ? (
          <p className="text-sm text-muted-foreground">
            Approved by {who(r.decidedBy)}
            {r.addedToList ? ` · added to ${r.addedToList}` : null}
          </p>
        ) : status === 'declined' ? (
          <p className="text-sm text-muted-foreground">
            {r.decidedBy ? `Declined by ${who(r.decidedBy)}` : 'Declined'}
            {r.reply ? `: ${r.reply}` : null}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Asked by {isOwn ? 'you' : r.requester.name} · {shortDate(r.createdAt, timeZone)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {decides && open ? (
          <>
            <Button size="sm" variant="ghost" onClick={onDecline} disabled={busy}>
              <X /> Decline
            </Button>
            <Button size="sm" onClick={onApprove} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve
            </Button>
          </>
        ) : null}
        {/* Once decided it can't be edited, only removed. */}
        {isOwn && open ? (
          <OwnerActions title={r.title} onEdit={onEdit} onDelete={onDelete} />
        ) : isOwn ? (
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Remove ${r.title}`}>
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Approving a purchase: put it on one of the shopping lists, or not. */
function ApproveDialog({
  request,
  lists,
  pending,
  onClose,
  onApprove,
}: {
  request: RequestDTO | null;
  lists: { id: string; name: string }[];
  pending: boolean;
  onClose: () => void;
  /** null: approved without putting it on a list. */
  onApprove: (listId: string | null) => void;
}) {
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title="Approve purchase"
      description={request ? `“${request.title}” from ${request.requester.name}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={pending} onClick={() => onApprove(listId || null)}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />}
            Approve
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="request-approve-list">Add it to a shopping list</Label>
        <Select id="request-approve-list" value={listId} onChange={(e) => setListId(e.target.value)}>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="">Don&apos;t add it to a list</option>
        </Select>
        <FieldNote
          id="request-approve-list-note"
          hint="Its link, picture, price and how many go with it, so whoever shops has it."
        />
      </div>
    </Dialog>
  );
}

/**
 * Assignee picks the date they'll have it done by - the request's deadline.
 * Without `requireDueDate` (the head's choice) the date may be left empty.
 */
function AcceptDialog({
  request,
  requireDueDate,
  pending,
  errors,
  onClose,
  onAccept,
}: {
  request: RequestDTO | null;
  requireDueDate: boolean;
  pending: boolean;
  /** The last try's field errors: a refused date is marked with why. */
  errors: FieldErrorsState;
  onClose: () => void;
  /** null: accepted (or saved) without a date. */
  onAccept: (dueAt: string | null) => void;
}) {
  const [date, setDate] = useState('');
  const min = todayInput();
  const valid = date === '' ? !requireDueDate : date >= min;
  const rescheduling = request?.status === 'accepted';
  const close = () => {
    setDate('');
    onClose();
  };

  return (
    <Dialog
      open={request !== null}
      onClose={close}
      title={rescheduling ? 'Change the done-by date' : 'Accept request'}
      description={request ? `“${request.title}” from ${request.requester.name}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={!valid || pending} onClick={() => onAccept(date ? noonIso(date) : null)}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {rescheduling ? 'Save date' : 'Accept'}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5" data-field="dueAt" {...errors.formProps}>
        <Label htmlFor="request-due">
          When will you have it done?{requireDueDate ? null : ' (optional)'}
        </Label>
        <Input
          id="request-due"
          type="date"
          min={min}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          {...errors.invalid('dueAt')}
        />
        <FieldNote
          id={errors.noteId('dueAt')}
          error={errors.get('dueAt') ?? (date !== '' && date < min ? 'Pick today or a later day.' : null)}
          hint={
            requireDueDate
              ? 'This becomes the deadline for the request.'
              : 'A date becomes the deadline for the request. Leave it empty for no deadline.'
          }
        />
      </div>
    </Dialog>
  );
}

/** Whoever handles the request says no, with an optional reason the requester sees. */
function DeclineDialog({
  request,
  pending,
  errors,
  onClose,
  onDecline,
}: {
  request: RequestDTO | null;
  pending: boolean;
  /** The last try's field errors: a refused reason is marked with why. */
  errors: FieldErrorsState;
  onClose: () => void;
  onDecline: (reply: string | null) => void;
}) {
  const [reply, setReply] = useState('');
  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title="Decline request"
      description={request ? `“${request.title}” from ${request.requester.name}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => onDecline(reply.trim() || null)}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Decline
          </Button>
        </>
      }
    >
      <div className="space-y-1.5" data-field="reply" {...errors.formProps}>
        <Label htmlFor="request-reply">Reason (optional)</Label>
        <Textarea
          id="request-reply"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={
            request?.category === 'maintenance'
              ? "e.g. I'm away this week, ask someone else"
              : request?.category === 'purchase'
                ? "e.g. Let's wait for your birthday"
                : request?.category === 'permission'
                  ? "e.g. Not on a school night"
                  : request?.issue
                    ? "e.g. That's the only copy there is"
                    : 'e.g. We already have it on another service'
          }
          maxLength={500}
          {...errors.invalid('reply')}
        />
        <FieldNote id={errors.noteId('reply')} error={errors.get('reply')} hint="Everyone in the household sees it." />
      </div>
    </Dialog>
  );
}

/**
 * Step-by-step request form: request type → (media: something new or a
 * problem → type of media → name and year, and for a problem where and what's
 * wrong) or (maintenance: what needs doing → who should do it) or (purchase:
 * what, link, price, how many, why) or (permission: what, from, until,
 * details). Each later step
 * appears once the one before it is chosen. The category, and whether media is
 * new or a problem, are fixed when editing.
 * What it offers comes from the head's Settings → Request types: the kinds this
 * member may ask for, the kinds of media, who may be asked and who is picked to
 * start with. A request being edited keeps its own kind and person even if the
 * head has since stopped offering them.
 */
export function RequestForm({
  initial,
  modules,
  members,
  submitLabel,
  pending,
  errors,
  onSubmit,
  onCancel,
}: {
  initial?: RequestDTO;
  /** The kinds of request that are on, as this member sees them. */
  modules: RequestModuleView[];
  members: MemberDTO[];
  submitLabel: string;
  pending: boolean;
  /** The last save's field errors: those fields are marked with why. */
  errors: FieldErrorsState;
  onSubmit: (payload: RequestPayload) => void;
  onCancel?: () => void;
}) {
  const askable = modules.filter((m) => m.canAsk);
  const mediaModule = modules.find((m) => m.id === 'media');
  const maintenanceModule = modules.find((m) => m.id === 'maintenance');
  const offeredMediaTypes = MEDIA_TYPES.filter(
    (t) => mediaModule?.mediaTypes.includes(t) || t === initial?.mediaType,
  );
  const assignees = members.filter(
    (m) => maintenanceModule?.assigneeIds.includes(m.id) || m.id === initial?.assignee?.id,
  );

  /** What picking a kind fills in to start with: the only media type, the default person. */
  const startingValues = (c: RequestCategory | '') => ({
    mediaType: c === 'media' && mediaModule?.mediaTypes.length === 1 ? mediaModule.mediaTypes[0] : ('' as const),
    assigneeId: c === 'maintenance' ? (maintenanceModule?.defaultAssigneeId ?? '') : '',
  });
  // Creating with only one kind to ask for: it's already picked.
  const firstCategory: RequestCategory | '' =
    (initial?.category as RequestCategory) ?? (askable.length === 1 ? askable[0].id : '');
  const firstValues = startingValues(firstCategory);

  const [category, setCategory] = useState<RequestCategory | ''>(firstCategory);
  const [mediaType, setMediaType] = useState<MediaType | ''>(
    (initial?.mediaType as MediaType) ?? firstValues.mediaType,
  );
  const [title, setTitle] = useState(initial?.title ?? '');
  const [year, setYear] = useState(initial?.year ? String(initial.year) : '');
  const [season, setSeason] = useState(initial?.season ? String(initial.season) : '');
  // Media problems: where (TV: the whole show, or a season and maybe an episode) and what's wrong.
  const [issue, setIssue] = useState(initial?.issue ?? false);
  const [wholeShow, setWholeShow] = useState(initial?.issue === true && initial.mediaType === 'tv' && !initial.season);
  const [episode, setEpisode] = useState(initial?.episode ? String(initial.episode) : '');
  const [problem, setProblem] = useState(initial?.issue ? (initial.details ?? '') : '');
  const [details, setDetails] = useState(initial?.details ?? '');
  const [assigneeId, setAssigneeId] = useState(initial?.assignee?.id ?? firstValues.assigneeId);
  // Purchase: link (Fetch details fills the picture and price), price of one, how many.
  const [url, setUrl] = useState(initial?.url ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(initial?.imageUrl ?? null);
  const [price, setPrice] = useState(initial?.price != null ? String(initial.price) : '');
  const [quantity, setQuantity] = useState(initial?.quantity ? String(initial.quantity) : '1');
  // Permission: from and until, as datetime-local values.
  const [startsAt, setStartsAt] = useState(localInput(initial?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(localInput(initial?.endsAt ?? null));
  const categoryModule = modules.find((m) => m.id === category);
  // Editing: the request's own kind, whether or not this member could ask for it now.
  const categoryOptions = initial
    ? [{ id: initial.category as RequestCategory, label: categoryModule?.label ?? REQUEST_CATEGORY_LABELS[initial.category as RequestCategory] ?? initial.category }]
    : askable;

  const yearNum = Number(year);
  // A TV problem names a season unless it's with the whole show; the episode stays optional.
  const tvProblem = issue && mediaType === 'tv';
  const needsSeason = tvProblem && !wholeShow;
  const seasonNum = season.trim() === '' || (tvProblem && wholeShow) ? null : Number(season);
  const episodeNum = !needsSeason || episode.trim() === '' ? null : Number(episode);
  const yearValid = /^\d{4}$/.test(year) && yearNum >= 1870 && yearNum <= 2100;
  const seasonValid =
    seasonNum === null ? !needsSeason : Number.isInteger(seasonNum) && seasonNum >= 1 && seasonNum <= 100;
  const episodeValid = episodeNum === null || (Number.isInteger(episodeNum) && episodeNum >= 1 && episodeNum <= 1000);
  const mediaReady =
    category === 'media' &&
    mediaType !== '' &&
    title.trim() !== '' &&
    yearValid &&
    seasonValid &&
    episodeValid &&
    (!issue || problem.trim() !== '');
  const maintenanceReady = category === 'maintenance' && title.trim() !== '' && assigneeId !== '';
  const priceNum = price.trim() === '' ? null : Number(price);
  const priceValid = priceNum === null || (Number.isFinite(priceNum) && priceNum >= 0 && priceNum <= 1_000_000);
  const quantityNum = Number(quantity);
  const quantityValid = Number.isInteger(quantityNum) && quantityNum >= 1 && quantityNum <= 999;
  const purchaseReady = category === 'purchase' && title.trim() !== '' && priceValid && quantityValid;
  // datetime-local values compare correctly as text.
  const untilError =
    errors.get('endsAt') ??
    (endsAt !== '' && startsAt === ''
      ? 'Say when it starts too.'
      : endsAt !== '' && endsAt <= startsAt
        ? 'Until has to be after from.'
        : null);
  const permissionReady = category === 'permission' && title.trim() !== '' && !untilError;

  const yearLabel =
    mediaType === 'tv'
      ? seasonNum && seasonValid
        ? `Year season ${seasonNum} came out`
        : 'Year of first season'
      : 'Release year';

  function submit() {
    // mediaReady also narrows mediaType past ''.
    if (category === 'media' && mediaReady) {
      onSubmit({
        category,
        mediaType,
        title: title.trim(),
        year: yearNum,
        season: mediaType === 'tv' ? seasonNum : null,
        issue,
        episode: episodeNum,
        details: issue ? problem.trim() : null,
      });
    } else if (category === 'maintenance' && maintenanceReady) {
      onSubmit({ category, title: title.trim(), details: details.trim() || null, assigneeId });
    } else if (category === 'purchase' && purchaseReady) {
      const link = url.trim();
      onSubmit({
        category,
        title: title.trim(),
        details: details.trim() || null,
        url: link || null,
        // A picture goes with its link.
        imageUrl: link ? imageUrl : null,
        price: priceNum,
        quantity: quantityNum,
      });
    } else if (category === 'permission' && permissionReady) {
      onSubmit({
        category,
        title: title.trim(),
        details: details.trim() || null,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: startsAt && endsAt ? new Date(endsAt).toISOString() : null,
      });
    }
  }

  // Why each is red: the server's word first, then what's checked here.
  const seasonError =
    errors.get('season') ??
    (seasonValid || (needsSeason && season === '')
      ? null
      : needsSeason
        ? 'Enter a season from 1 to 100.'
        : 'Enter a season from 1 to 100, or leave it blank.');
  const episodeError = errors.get('episode') ?? (episodeValid ? null : 'Enter an episode from 1 to 1000, or leave it blank.');
  const yearError =
    errors.get('year') ?? (year !== '' && !yearValid ? 'Enter a 4-digit year from 1870 to 2100.' : null);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      {...errors.formProps}
    >
      <div className="space-y-1.5" data-field="category">
        <Label htmlFor="request-category">What would you like to request?</Label>
        <Select
          id="request-category"
          value={category}
          disabled={initial !== undefined}
          onChange={(e) => {
            const next = e.target.value as RequestCategory | '';
            setCategory(next);
            const start = startingValues(next);
            if (start.mediaType && !mediaType) setMediaType(start.mediaType);
            if (start.assigneeId && !assigneeId) setAssigneeId(start.assigneeId);
          }}
          {...errors.invalid('category')}
        >
          <option value="" disabled>
            Choose…
          </option>
          {categoryOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
        {/* The head's note for this kind (Settings → Request types). */}
        <FieldNote id={errors.noteId('category')} error={errors.get('category')} hint={categoryModule?.note ?? undefined} />
      </div>

      {category === 'media' ? (
        <div className="space-y-1.5" data-field="issue">
          <Label htmlFor="request-media-purpose">What do you need?</Label>
          <Select
            id="request-media-purpose"
            value={issue ? 'issue' : 'add'}
            disabled={initial !== undefined}
            onChange={(e) => setIssue(e.target.value === 'issue')}
          >
            <option value="add">Something new added</option>
            <option value="issue">A problem fixed with something we have</option>
          </Select>
        </div>
      ) : null}

      {category === 'media' ? (
        <div className="space-y-1.5" data-field="mediaType">
          <Label htmlFor="request-media-type">Type of media</Label>
          <Select
            id="request-media-type"
            value={mediaType}
            onChange={(e) => setMediaType(e.target.value as MediaType | '')}
            {...errors.invalid('mediaType')}
          >
            <option value="" disabled>
              Choose…
            </option>
            {offeredMediaTypes.map((t) => (
              <option key={t} value={t}>
                {MEDIA_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <FieldNote id={errors.noteId('mediaType')} error={errors.get('mediaType')} />
        </div>
      ) : null}

      {category === 'media' && mediaType !== '' ? (
        <>
          <div className="space-y-1.5" data-field="title">
            <Label htmlFor="request-title">Name</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={mediaType === 'tv' ? 'e.g. Severance' : 'e.g. Dune'}
              maxLength={200}
              required
              {...errors.invalid('title')}
            />
            <FieldNote id={errors.noteId('title')} error={errors.get('title')} />
          </div>
          {tvProblem ? (
            <label className="flex items-center gap-2 text-sm" data-field="wholeShow">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                checked={wholeShow}
                onChange={(e) => setWholeShow(e.target.checked)}
              />
              It&apos;s the whole show, not one season
            </label>
          ) : null}
          <div className={cn('grid gap-4', needsSeason ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
            {needsSeason ? (
              <>
                <div className="space-y-1.5" data-field="season">
                  <Label htmlFor="request-season">Season</Label>
                  <Input
                    id="request-season"
                    inputMode="numeric"
                    value={season}
                    onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    placeholder="e.g. 2"
                    aria-invalid={seasonError ? true : undefined}
                    aria-describedby={errors.noteId('season')}
                    required
                  />
                  <FieldNote id={errors.noteId('season')} error={seasonError} />
                </div>
                <div className="space-y-1.5" data-field="episode">
                  <Label htmlFor="request-episode">Episode (optional)</Label>
                  <Input
                    id="request-episode"
                    inputMode="numeric"
                    value={episode}
                    onChange={(e) => setEpisode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="Whole season"
                    aria-invalid={episodeError ? true : undefined}
                    aria-describedby={errors.noteId('episode')}
                  />
                  <FieldNote
                    id={errors.noteId('episode')}
                    error={episodeError}
                    hint="Leave blank if it's the whole season."
                  />
                </div>
              </>
            ) : mediaType === 'tv' && !tvProblem ? (
              <div className="space-y-1.5" data-field="season">
                <Label htmlFor="request-season">Season (optional)</Label>
                <Input
                  id="request-season"
                  inputMode="numeric"
                  value={season}
                  onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="Whole show"
                  aria-invalid={seasonError ? true : undefined}
                  aria-describedby={errors.noteId('season')}
                />
                <FieldNote
                  id={errors.noteId('season')}
                  error={seasonError}
                  hint="Leave blank to request the whole show."
                />
              </div>
            ) : null}
            <div className="space-y-1.5" data-field="year">
              <Label htmlFor="request-year">{yearLabel}</Label>
              <Input
                id="request-year"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="YYYY"
                aria-invalid={yearError ? true : undefined}
                aria-describedby={errors.noteId('year')}
                required
              />
              <FieldNote id={errors.noteId('year')} error={yearError} />
            </div>
          </div>
          {issue ? (
            <div className="space-y-1.5" data-field="details">
              <Label htmlFor="request-problem">What&apos;s wrong?</Label>
              <Textarea
                id="request-problem"
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                placeholder="e.g. No sound after 20 minutes, or the subtitles are out of sync"
                maxLength={2000}
                required
                {...errors.invalid('details')}
              />
              <FieldNote id={errors.noteId('details')} error={errors.get('details')} />
            </div>
          ) : null}
        </>
      ) : null}

      {category === 'maintenance' ? (
        <>
          <div className="space-y-1.5" data-field="title">
            <Label htmlFor="request-title">What needs doing?</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Fix the leaky kitchen faucet"
              maxLength={200}
              required
              {...errors.invalid('title')}
            />
            <FieldNote id={errors.noteId('title')} error={errors.get('title')} />
          </div>
          <div className="space-y-1.5" data-field="details">
            <Label htmlFor="request-details">Details (optional)</Label>
            <Textarea
              id="request-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Where it is, what's wrong, anything that helps"
              maxLength={2000}
              {...errors.invalid('details')}
            />
            <FieldNote id={errors.noteId('details')} error={errors.get('details')} />
          </div>
          <div className="space-y-1.5" data-field="assigneeId">
            <Label htmlFor="request-assignee">Who should do it?</Label>
            <Select
              id="request-assignee"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              {...errors.invalid('assigneeId')}
            >
              <option value="" disabled>
                Choose someone…
              </option>
              {assignees.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <FieldNote
              id={errors.noteId('assigneeId')}
              error={errors.get('assigneeId')}
              hint={assignees.length === 0 ? "There's no one you can ask yet." : undefined}
            />
            {initial?.status === 'accepted' && assigneeId !== initial.assignee?.id ? (
              <p className="text-xs text-muted-foreground">
                Changing who does it sends the request back for them to accept.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {category === 'purchase' ? (
        <>
          <div className="space-y-1.5" data-field="title">
            <Label htmlFor="request-title">What would you like?</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. LEGO Space set"
              maxLength={200}
              required
              {...errors.invalid('title')}
            />
            <FieldNote id={errors.noteId('title')} error={errors.get('title')} />
          </div>
          <div data-field="url imageUrl">
            <LinkField
              id="request-url"
              label="Link (optional)"
              previewPath="/api/requests/preview"
              url={url}
              imageUrl={imageUrl}
              error={errors.first('url', 'imageUrl')}
              onUrlChange={(value) => {
                setUrl(value);
                setImageUrl(null);
              }}
              onPreview={(preview) => {
                if (preview.imageUrl) setImageUrl(preview.imageUrl);
                if (preview.title && !title.trim()) setTitle(preview.title);
                if (preview.price != null && !price) setPrice(String(preview.price));
              }}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5" data-field="price">
              <Label htmlFor="request-price">Est. price (optional)</Label>
              <Input
                id="request-price"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                aria-invalid={errors.get('price') || !priceValid ? true : undefined}
                aria-describedby={errors.noteId('price')}
              />
              <FieldNote
                id={errors.noteId('price')}
                error={errors.get('price') ?? (priceValid ? null : 'Enter a price of 0 or more.')}
                hint="For one."
              />
            </div>
            <div className="space-y-1.5" data-field="quantity">
              <Label htmlFor="request-quantity">How many</Label>
              <Input
                id="request-quantity"
                type="number"
                min={1}
                max={999}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-invalid={errors.get('quantity') || !quantityValid ? true : undefined}
                aria-describedby={errors.noteId('quantity')}
              />
              <FieldNote
                id={errors.noteId('quantity')}
                error={errors.get('quantity') ?? (quantityValid ? null : 'Enter a number from 1 to 999.')}
              />
            </div>
          </div>
          <div className="space-y-1.5" data-field="details">
            <Label htmlFor="request-details">Why (optional)</Label>
            <Textarea
              id="request-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="What it's for, anything that helps decide"
              maxLength={2000}
              {...errors.invalid('details')}
            />
            <FieldNote id={errors.noteId('details')} error={errors.get('details')} />
          </div>
        </>
      ) : null}

      {category === 'permission' ? (
        <>
          <div className="space-y-1.5" data-field="title">
            <Label htmlFor="request-title">What would you like to do?</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sleepover at Sam's"
              maxLength={200}
              required
              {...errors.invalid('title')}
            />
            <FieldNote id={errors.noteId('title')} error={errors.get('title')} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5" data-field="startsAt">
              <Label htmlFor="request-starts">From (optional)</Label>
              <Input
                id="request-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                {...errors.invalid('startsAt')}
              />
              <FieldNote
                id={errors.noteId('startsAt')}
                error={errors.get('startsAt')}
                hint="Leave empty if there's no time, like a new app."
              />
            </div>
            <div className="space-y-1.5" data-field="endsAt">
              <Label htmlFor="request-ends">Until (optional)</Label>
              <Input
                id="request-ends"
                type="datetime-local"
                value={endsAt}
                min={startsAt || undefined}
                onChange={(e) => setEndsAt(e.target.value)}
                aria-invalid={untilError ? true : undefined}
                aria-describedby={errors.noteId('endsAt')}
              />
              <FieldNote id={errors.noteId('endsAt')} error={untilError} />
            </div>
          </div>
          <div className="space-y-1.5" data-field="details">
            <Label htmlFor="request-details">Details (optional)</Label>
            <Textarea
              id="request-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Where, who with, how you'll get there"
              maxLength={2000}
              {...errors.invalid('details')}
            />
            <FieldNote id={errors.noteId('details')} error={errors.get('details')} />
          </div>
        </>
      ) : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={!(mediaReady || maintenanceReady || purchaseReady || permissionReady) || pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
