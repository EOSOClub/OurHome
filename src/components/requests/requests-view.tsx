'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  Check,
  Film,
  Inbox,
  Loader2,
  Pencil,
  Trash2,
  Tv,
  Wrench,
} from 'lucide-react';
import type { MemberDTO, RequestDTO } from '@/lib/types';
import {
  MAINTENANCE_STATUSES,
  MAINTENANCE_STATUS_LABELS,
  MEDIA_TYPES,
  MEDIA_TYPE_LABELS,
  MEDIA_STATUS_LABELS,
  MEDIA_TYPE_SECTION_LABELS,
  REQUEST_CATEGORIES,
  REQUEST_CATEGORY_LABELS,
  type MaintenanceStatus,
  type MediaType,
  type RequestCategory,
} from '@/lib/enums';
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
import { EmptyState } from '@/components/empty-state';

export type RequestPayload =
  | {
      category: 'media';
      mediaType: MediaType;
      title: string;
      year: number;
      season: number | null;
    }
  | {
      category: 'maintenance';
      title: string;
      details: string | null;
      assigneeId: string;
    };

const MEDIA_ICONS: Record<MediaType, typeof Film> = { movie: Film, tv: Tv };

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** A date-input value ("YYYY-MM-DD") → noon local, matching the other forms. */
const noonIso = (date: string) => new Date(`${date}T12:00`).toISOString();

/** Today as a date-input value in local time. */
const todayInput = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function RequestsView({
  initialRequests,
  currentUserId,
  members,
  canWrite,
  canManageMedia,
}: {
  initialRequests: RequestDTO[];
  currentUserId: string;
  members: MemberDTO[];
  canWrite: boolean;
  /** Head: accepts media requests and marks them available. */
  canManageMedia: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RequestDTO | null>(null);
  const [accepting, setAccepting] = useState<RequestDTO | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RequestDTO | null>(null);
  // Bumped after a successful create so the form remounts empty.
  const [formKey, setFormKey] = useState(0);

  const { data: requests = [] } = useQuery({
    queryKey: ['requests'],
    queryFn: () => apiFetch<RequestDTO[]>('/api/requests'),
    initialData: initialRequests,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['requests'] });
  const post = <T,>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });

  const createMutation = useMutation({
    mutationFn: (payload: RequestPayload) => post<RequestDTO>('/api/requests', payload),
    onSuccess: (r) => {
      toast.success(
        r.category === 'maintenance' ? `Sent to ${r.assignee?.name ?? 'them'}` : `Requested “${r.title}”`,
      );
      setFormKey((k) => k + 1);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: RequestPayload & { id: string }) =>
      post<RequestDTO>('/api/requests/update', payload),
    onSuccess: () => {
      toast.success('Request updated');
      setEditing(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => post<{ id: string }>('/api/requests/delete', { id }),
    onSuccess: () => {
      toast.success('Request removed');
      setConfirmDelete(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // dueAt is required for maintenance and omitted for media.
  const acceptMutation = useMutation({
    mutationFn: (input: { id: string; dueAt?: string }) => post<RequestDTO>('/api/requests/accept', input),
    onSuccess: (r) => {
      toast.success(r.dueAt ? `Done by ${shortDate(r.dueAt)} — got it` : `Accepted “${r.title}”`);
      setAccepting(null);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => post<RequestDTO>('/api/requests/complete', { id }),
    onSuccess: (r) => {
      toast.success(r.category === 'media' ? `“${r.title}” is available` : `Marked “${r.title}” done`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busyId = acceptMutation.isPending
    ? acceptMutation.variables?.id
    : completeMutation.isPending
      ? completeMutation.variables
      : undefined;

  const media = requests.filter((r) => r.category === 'media');
  const maintenance = requests.filter((r) => r.category === 'maintenance');
  const others = members.filter((m) => m.id !== currentUserId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Requests</h1>
        <p className="text-sm text-muted-foreground">
          Ask the household for something. Everyone can see every request.
        </p>
      </div>

      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>New request</CardTitle>
            <CardDescription>Pick what you&apos;re requesting, then fill in the details.</CardDescription>
          </CardHeader>
          <CardContent>
            <RequestForm
              key={formKey}
              assignees={others}
              submitLabel="Request"
              pending={createMutation.isPending}
              onSubmit={(payload) => createMutation.mutate(payload)}
            />
          </CardContent>
        </Card>
      ) : null}

      {requests.length === 0 ? (
        <EmptyState icon={Inbox} title="No requests yet" description="Requests you and your household make show up here." />
      ) : null}

      {maintenance.length > 0 ? (
        <section className="space-y-4">
          <CategoryHeader category="maintenance" />
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
                      busy={busyId === r.id}
                      onAccept={() => setAccepting(r)}
                      onComplete={() => completeMutation.mutate(r.id)}
                      onEdit={() => setEditing(r)}
                      onDelete={() => setConfirmDelete(r)}
                    />
                  ))}
                </ul>
              </div>
            );
          })}
        </section>
      ) : null}

      {media.length > 0 ? (
        <section className="space-y-4">
          <CategoryHeader category="media" />
          {MEDIA_TYPES.map((type) => {
            const items = media.filter((r) => r.mediaType === type);
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
                    {items.map((r) => (
                      <MediaRow
                        key={r.id}
                        request={r}
                        isOwn={r.requester.id === currentUserId}
                        canManage={canManageMedia}
                        busy={busyId === r.id}
                        onAccept={() => acceptMutation.mutate({ id: r.id })}
                        onComplete={() => completeMutation.mutate(r.id)}
                        onEdit={() => setEditing(r)}
                        onDelete={() => setConfirmDelete(r)}
                      />
                    ))}
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
            assignees={others}
            submitLabel="Save changes"
            pending={updateMutation.isPending}
            onCancel={() => setEditing(null)}
            onSubmit={(payload) => updateMutation.mutate({ ...payload, id: editing.id })}
          />
        ) : null}
      </Dialog>

      <AcceptDialog
        request={accepting}
        pending={acceptMutation.isPending}
        onClose={() => setAccepting(null)}
        onAccept={(dueAt) => accepting && acceptMutation.mutate({ id: accepting.id, dueAt })}
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

function CategoryHeader({ category }: { category: RequestCategory }) {
  const Icon = category === 'maintenance' ? Wrench : Film;
  return (
    <h2 className="flex items-center gap-2 border-b border-border pb-1 text-lg font-semibold">
      <Icon className="size-5" /> {REQUEST_CATEGORY_LABELS[category]}
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

const MEDIA_STATUS_BADGE: Record<MaintenanceStatus, 'secondary' | 'default' | 'success'> = {
  pending: 'secondary',
  accepted: 'default',
  completed: 'success',
};

function MediaRow({
  request: r,
  isOwn,
  canManage,
  busy,
  onAccept,
  onComplete,
  onEdit,
  onDelete,
}: {
  request: RequestDTO;
  isOwn: boolean;
  canManage: boolean;
  busy: boolean;
  onAccept: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Requests from before statuses existed have none: treat as pending.
  const status = (r.status ?? 'pending') as MaintenanceStatus;
  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center', canManage && status === 'pending' && 'bg-primary/5')}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="truncate">
            {r.title} <span className="font-normal text-muted-foreground">({r.year})</span>
          </span>
          {r.season ? <Badge variant="outline">Season {r.season}</Badge> : null}
          <Badge variant={MEDIA_STATUS_BADGE[status]}>{MEDIA_STATUS_LABELS[status]}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          Requested by {isOwn ? 'you' : r.requester.name} · {shortDate(r.createdAt)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {canManage && status === 'pending' ? (
          <Button size="sm" onClick={onAccept} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null} Accept
          </Button>
        ) : null}
        {canManage && status === 'accepted' ? (
          <Button size="sm" variant="outline" onClick={onComplete} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Mark available
          </Button>
        ) : null}
        {isOwn ? <OwnerActions title={r.title} onEdit={onEdit} onDelete={onDelete} /> : null}
      </div>
    </li>
  );
}

function MaintenanceRow({
  request: r,
  currentUserId,
  busy,
  onAccept,
  onComplete,
  onEdit,
  onDelete,
}: {
  request: RequestDTO;
  currentUserId: string;
  busy: boolean;
  onAccept: () => void;
  onComplete: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isRequester = r.requester.id === currentUserId;
  const isAssignee = r.assignee?.id === currentUserId;
  const overdue = r.status === 'accepted' && r.dueAt !== null && new Date(r.dueAt) < startOfToday();
  const who = (m: { id: string; name: string } | null) =>
    !m ? 'someone' : m.id === currentUserId ? 'you' : m.name;

  return (
    <li className={cn('flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center', isAssignee && r.status === 'pending' && 'bg-primary/5')}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className={cn('truncate', r.status === 'completed' && 'text-muted-foreground line-through')}>
            {r.title}
          </span>
          {r.status === 'accepted' && r.dueAt ? (
            <Badge variant={overdue ? 'destructive' : 'default'}>
              <CalendarClock className="size-3" /> {overdue ? 'Overdue · ' : 'Done by '}
              {shortDate(r.dueAt)}
            </Badge>
          ) : null}
          {r.status === 'completed' && r.completedAt ? (
            <Badge variant="success">Done {shortDate(r.completedAt)}</Badge>
          ) : null}
        </p>
        {r.details ? <p className="text-sm text-muted-foreground">{r.details}</p> : null}
        <p className="text-xs text-muted-foreground">
          {isRequester ? 'You' : who(r.requester)} asked {who(r.assignee)} · {shortDate(r.createdAt)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {isAssignee && r.status === 'pending' ? (
          <Button size="sm" onClick={onAccept}>
            Accept
          </Button>
        ) : null}
        {isAssignee && r.status === 'accepted' ? (
          <>
            <Button size="sm" variant="ghost" onClick={onAccept}>
              Change date
            </Button>
            <Button size="sm" variant="outline" onClick={onComplete} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Mark done
            </Button>
          </>
        ) : null}
        {isRequester ? <OwnerActions title={r.title} onEdit={onEdit} onDelete={onDelete} /> : null}
      </div>
    </li>
  );
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Assignee picks the date they'll have it done by — the request's deadline. */
function AcceptDialog({
  request,
  pending,
  onClose,
  onAccept,
}: {
  request: RequestDTO | null;
  pending: boolean;
  onClose: () => void;
  onAccept: (dueAt: string) => void;
}) {
  const [date, setDate] = useState('');
  const min = todayInput();
  const valid = date !== '' && date >= min;
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
          <Button
            disabled={!valid || pending}
            onClick={() => {
              onAccept(noonIso(date));
              setDate('');
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {rescheduling ? 'Save date' : 'Accept'}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="request-due">When will you have it done?</Label>
        <Input id="request-due" type="date" min={min} value={date} onChange={(e) => setDate(e.target.value)} />
        <p className="text-xs text-muted-foreground">This becomes the deadline for the request.</p>
      </div>
    </Dialog>
  );
}

/**
 * Step-by-step request form: request type → (media: type of media → name and
 * year) or (maintenance: what needs doing → who should do it). Each later step
 * appears once the one before it is chosen. The category is fixed when editing.
 */
export function RequestForm({
  initial,
  assignees,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial?: RequestDTO;
  assignees: MemberDTO[];
  submitLabel: string;
  pending: boolean;
  onSubmit: (payload: RequestPayload) => void;
  onCancel?: () => void;
}) {
  const [category, setCategory] = useState<RequestCategory | ''>(
    (initial?.category as RequestCategory) ?? '',
  );
  const [mediaType, setMediaType] = useState<MediaType | ''>((initial?.mediaType as MediaType) ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [year, setYear] = useState(initial?.year ? String(initial.year) : '');
  const [season, setSeason] = useState(initial?.season ? String(initial.season) : '');
  const [details, setDetails] = useState(initial?.details ?? '');
  const [assigneeId, setAssigneeId] = useState(initial?.assignee?.id ?? '');

  const yearNum = Number(year);
  const seasonNum = season.trim() === '' ? null : Number(season);
  const yearValid = /^\d{4}$/.test(year) && yearNum >= 1870 && yearNum <= 2100;
  const seasonValid = seasonNum === null || (Number.isInteger(seasonNum) && seasonNum >= 1 && seasonNum <= 100);
  const mediaReady = category === 'media' && mediaType !== '' && title.trim() !== '' && yearValid && seasonValid;
  const maintenanceReady = category === 'maintenance' && title.trim() !== '' && assigneeId !== '';

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
      });
    } else if (category === 'maintenance' && maintenanceReady) {
      onSubmit({ category, title: title.trim(), details: details.trim() || null, assigneeId });
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="request-category">What would you like to request?</Label>
        <Select
          id="request-category"
          value={category}
          disabled={initial !== undefined}
          onChange={(e) => setCategory(e.target.value as RequestCategory | '')}
        >
          <option value="" disabled>
            Choose…
          </option>
          {REQUEST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {REQUEST_CATEGORY_LABELS[c]}
            </option>
          ))}
        </Select>
      </div>

      {category === 'media' ? (
        <div className="space-y-1.5">
          <Label htmlFor="request-media-type">Type of media</Label>
          <Select
            id="request-media-type"
            value={mediaType}
            onChange={(e) => setMediaType(e.target.value as MediaType | '')}
          >
            <option value="" disabled>
              Choose…
            </option>
            {MEDIA_TYPES.map((t) => (
              <option key={t} value={t}>
                {MEDIA_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {category === 'media' && mediaType !== '' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="request-title">Name</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={mediaType === 'tv' ? 'e.g. Severance' : 'e.g. Dune'}
              maxLength={200}
              required
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {mediaType === 'tv' ? (
              <div className="space-y-1.5">
                <Label htmlFor="request-season">Season (optional)</Label>
                <Input
                  id="request-season"
                  inputMode="numeric"
                  value={season}
                  onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  placeholder="Whole show"
                  aria-invalid={!seasonValid}
                />
                <p className="text-xs text-muted-foreground">Leave blank to request the whole show.</p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="request-year">{yearLabel}</Label>
              <Input
                id="request-year"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="YYYY"
                aria-invalid={year !== '' && !yearValid}
                required
              />
            </div>
          </div>
        </>
      ) : null}

      {category === 'maintenance' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="request-title">What needs doing?</Label>
            <Input
              id="request-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Fix the leaky kitchen faucet"
              maxLength={200}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-details">Details (optional)</Label>
            <Textarea
              id="request-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Where it is, what's wrong, anything that helps"
              maxLength={2000}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="request-assignee">Who should do it?</Label>
            <Select id="request-assignee" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="" disabled>
                Choose someone…
              </option>
              {assignees.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            {initial?.status === 'accepted' && assigneeId !== initial.assignee?.id ? (
              <p className="text-xs text-muted-foreground">
                Changing who does it sends the request back for them to accept.
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={!(mediaReady || maintenanceReady) || pending}>
          {pending ? <Loader2 className="animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
