'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Copy,
  Loader2,
  Plus,
  Receipt,
  Repeat,
  Trash2,
} from 'lucide-react';
import type { BillDTO, MemberDTO } from '@/lib/types';
import { BILL_STATUS_LABELS, type BillStatus } from '@/lib/enums';
import { formatDueDate, formatMoney, isDueWithinDays, isOverdue } from '@/lib/format';
import { apiFetch, ApiError } from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState } from '@/components/empty-state';
import { PaymentDialog } from '@/components/bills/payment-dialog';

const KEY = ['bills'];
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';

// How many paid bills the disclosure shows before "Show all (N)".
const PAID_PREVIEW = 12;

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

// RecurrenceDTO carries byWeekday/byMonthday as comma-delimited strings.
function parseList(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

function toggleIn(list: number[], value: number): number[] {
  return list.includes(value)
    ? list.filter((d) => d !== value)
    : [...list, value];
}

/**
 * POST /api/bills payload cloning a bill's descriptive fields (shared with the
 * detail page's Duplicate action). Payments, status, and email-linkage fields
 * (reference/invoiceNo/…) intentionally aren't copied; recurring bills start at
 * their next occurrence. 'cron' rules can't round-trip through the create
 * schema, so the copy of such a bill is one-off.
 */
export function duplicateBillPayload(bill: BillDTO) {
  const byWeekday = parseList(bill.recurrence?.byWeekday);
  const byMonthday = parseList(bill.recurrence?.byMonthday);
  const recurrence =
    bill.recurrence && bill.recurrence.kind !== 'cron'
      ? {
          kind: bill.recurrence.kind,
          interval: bill.recurrence.interval,
          timezone: bill.recurrence.timezone,
          until: bill.recurrence.until,
          ...(byWeekday.length > 0 ? { byWeekday } : {}),
          ...(byMonthday.length > 0 ? { byMonthday } : {}),
        }
      : undefined;
  return {
    name: `${bill.name} (copy)`.slice(0, 160),
    amount: bill.amount,
    currency: bill.currency,
    dueDate: bill.recurrence?.nextRunAt ?? bill.dueDate,
    category: bill.category,
    autoPay: bill.autoPay,
    notes: bill.notes,
    assignedUserId: bill.assignee?.id ?? null,
    recurrence,
  };
}

/** Amount still owed on a bill (balance minus payments already applied). */
const outstanding = (b: BillDTO) => Math.max(0, b.amount - b.paidTotal);
const sum = (bills: BillDTO[], f: (b: BillDTO) => number) =>
  bills.reduce((acc, b) => acc + f(b), 0);

export function BillsView({
  initialBills,
  members,
  canWrite,
  paidThisMonth,
}: {
  initialBills: BillDTO[];
  members: MemberDTO[];
  canWrite: boolean;
  paidThisMonth: number;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<'new' | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [showAllPaid, setShowAllPaid] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const { data: bills = [] } = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<BillDTO[]>('/api/bills'),
    initialData: initialBills,
  });

  const unpaid = bills.filter((b) => b.status === 'unpaid');
  const paid = bills.filter((b) => b.status === 'paid');
  const overdue = unpaid.filter((b) => isOverdue(b.dueDate));
  const upcoming = unpaid.filter((b) => !isOverdue(b.dueDate));

  const dueThisWeek = upcoming.filter((b) => isDueWithinDays(b.dueDate, 7));

  // Stats always cover every bill; only the buckets below honor the filters.
  const totalDue = sum(unpaid, outstanding);
  const overdueTotal = sum(overdue, outstanding);
  const dueThisWeekTotal = sum(dueThisWeek, outstanding);

  const categories = [...new Set(bills.map((b) => b.category))]
    .filter((c): c is string => !!c)
    .sort();
  const query = search.trim().toLowerCase();
  const filtersActive = query !== '' || category !== '';
  const matchesFilters = (b: BillDTO) =>
    (!query || b.name.toLowerCase().includes(query)) &&
    (!category || b.category === category);
  const shownOverdue = overdue.filter(matchesFilters);
  const shownUpcoming = upcoming.filter(matchesFilters);
  const shownPaid = paid.filter(matchesFilters);

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: KEY });
    setEditing(null);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bills &amp; expenses</h1>
          <p className="text-sm text-muted-foreground">
            {unpaid.length} unpaid · {formatMoney(totalDue)} outstanding
          </p>
        </div>
        {canWrite ? (
          <Button onClick={() => setEditing('new')}>
            <Plus /> New bill
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Outstanding" value={formatMoney(totalDue)} icon={Receipt} />
        <StatCard
          label="Overdue"
          value={formatMoney(overdueTotal)}
          icon={AlertTriangle}
          tone={overdue.length > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="Due this week"
          value={formatMoney(dueThisWeekTotal)}
          icon={CalendarClock}
          tone={dueThisWeek.length > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Paid this month"
          value={formatMoney(paidThisMonth)}
          icon={CheckCircle2}
          tone="success"
        />
      </div>

      {bills.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No bills yet"
          description="Track recurring bills and one-off expenses here."
        />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bills…"
              aria-label="Search bills by name"
              className="w-full sm:max-w-xs"
            />
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Filter by category"
              className="w-auto"
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>

          {filtersActive &&
          shownOverdue.length + shownUpcoming.length + shownPaid.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              No bills match your filters.
            </p>
          ) : (
            <>
              {shownOverdue.length > 0 ? (
                <Section title="Overdue" count={shownOverdue.length}>
                  <BillList bills={shownOverdue} canWrite={canWrite} />
                </Section>
              ) : null}

              <Section title="Upcoming" count={shownUpcoming.length}>
                {shownUpcoming.length > 0 ? (
                  <BillList bills={shownUpcoming} canWrite={canWrite} />
                ) : (
                  <p className="px-1 text-sm text-muted-foreground">
                    Nothing due — you&apos;re all caught up.
                  </p>
                )}
              </Section>

              {shownPaid.length > 0 ? (
                <div>
                  <button
                    type="button"
                    aria-expanded={showPaid}
                    onClick={() => setShowPaid((v) => !v)}
                    className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown
                      className={`size-4 transition-transform ${showPaid ? '' : '-rotate-90'}`}
                    />
                    Paid ({shownPaid.length})
                  </button>
                  {showPaid ? (
                    <div className="mt-3 space-y-3">
                      <BillList
                        bills={
                          showAllPaid ? shownPaid : shownPaid.slice(0, PAID_PREVIEW)
                        }
                        canWrite={canWrite}
                      />
                      {!showAllPaid && shownPaid.length > PAID_PREVIEW ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllPaid(true)}
                        >
                          Show all ({shownPaid.length})
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      {editing !== null ? (
        <BillDialog
          bill={null}
          members={members}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">
        {title} ({count})
      </h2>
      {children}
    </section>
  );
}

function BillList({ bills, canWrite }: { bills: BillDTO[]; canWrite: boolean }) {
  return (
    <ul className="space-y-2">
      {bills.map((bill) => (
        <BillRow key={bill.id} bill={bill} canWrite={canWrite} />
      ))}
    </ul>
  );
}

function BillRow({ bill, canWrite }: { bill: BillDTO; canWrite: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [paying, setPaying] = useState(false);

  // Also re-render the server component — the "Paid this month" stat is a
  // server prop and would go stale on invalidation alone.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: KEY });
    router.refresh();
  };

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<{ id: string }>('/api/bills/delete', {
        method: 'POST',
        body: JSON.stringify({ id: bill.id }),
      }),
    onSuccess: () => {
      toast.success('Bill deleted');
      refresh();
    },
  });

  const duplicate = useMutation({
    mutationFn: () =>
      apiFetch<BillDTO>('/api/bills', {
        method: 'POST',
        body: JSON.stringify(duplicateBillPayload(bill)),
      }),
    onSuccess: () => {
      toast.success('Bill duplicated');
      refresh();
    },
  });

  const overdue = bill.status === 'unpaid' && isOverdue(bill.dueDate);
  const partial =
    bill.status === 'unpaid' && bill.paidTotal > 0 && bill.paidTotal < bill.amount;
  const statusVariant =
    bill.status === 'paid' ? 'success' : overdue ? 'destructive' : 'warning';
  const statusLabel = overdue
    ? 'Overdue'
    : partial
      ? 'Partial'
      : (BILL_STATUS_LABELS[bill.status as BillStatus] ?? bill.status);
  const pct =
    bill.amount > 0 ? Math.min(100, Math.round((bill.paidTotal / bill.amount) * 100)) : 0;

  return (
    <li className="relative flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/40">
      {/* Stretched link makes the whole row navigate; action buttons sit above it. */}
      <Link
        href={`/bills/${bill.id}`}
        className="absolute inset-0 rounded-lg"
        aria-label={`View ${bill.name}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{bill.name}</p>
          {bill.recurrence ? (
            <Repeat className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          {bill.source === 'email' || bill.source === 'paperless' ? (
            <Badge variant="secondary" className="text-[10px]">
              {bill.source === 'paperless' ? 'Paperless' : 'Email'}
            </Badge>
          ) : null}
          {bill.autoPay ? (
            <Badge variant="secondary" className="text-[10px]">
              Auto-pay
            </Badge>
          ) : null}
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarClock className="size-3.5" />
          {bill.dueDate ? formatDueDate(bill.dueDate) : 'No due date'}
          {bill.category ? ` · ${bill.category}` : ''}
          {bill.assignee ? ` · ${bill.assignee.name}` : ''}
        </p>
        {partial ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Paid {formatMoney(bill.paidTotal, bill.currency)} of{' '}
            {formatMoney(bill.amount, bill.currency)} · {pct}%
          </p>
        ) : null}
      </div>

      <span className="text-right font-semibold tabular-nums">
        {formatMoney(bill.amount, bill.currency)}
      </span>
      <Badge variant={statusVariant}>{statusLabel}</Badge>

      {canWrite ? (
        <div className="relative z-10 flex items-center gap-1">
          {bill.status === 'unpaid' ? (
            <Button variant="outline" size="sm" onClick={() => setPaying(true)}>
              <CheckCircle2 />
              Mark paid
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground"
            aria-label={`Duplicate ${bill.name}`}
            disabled={duplicate.isPending}
            onClick={() => duplicate.mutate()}
          >
            {duplicate.isPending ? <Loader2 className="animate-spin" /> : <Copy />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${bill.name}`}
            disabled={remove.isPending}
            onClick={() => setConfirmDelete(true)}
          >
            {remove.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </div>
      ) : null}

      {paying ? (
        <PaymentDialog
          bill={bill}
          onClose={() => setPaying(false)}
          onSaved={() => {
            setPaying(false);
            refresh();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          remove.mutate();
        }}
        title="Delete bill"
        description={`Delete "${bill.name}"? This can't be undone.`}
        confirmLabel="Delete"
        destructive
      />
    </li>
  );
}

export function BillDialog({
  bill,
  members,
  onClose,
  onSaved,
}: {
  bill: BillDTO | null;
  members: MemberDTO[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(bill?.name ?? '');
  const [amount, setAmount] = useState(bill ? String(bill.amount) : '');
  const [dueDate, setDueDate] = useState(
    bill?.dueDate ? dateValue(new Date(bill.dueDate)) : '',
  );
  const [category, setCategory] = useState(bill?.category ?? '');
  const [autoPay, setAutoPay] = useState(bill?.autoPay ?? false);
  const [assignedUserId, setAssignedUserId] = useState(bill?.assignee?.id ?? '');
  const [notes, setNotes] = useState(bill?.notes ?? '');
  const [repeat, setRepeat] = useState<Repeat>(
    (bill?.recurrence?.kind as Repeat) ?? 'none',
  );
  const [interval, setInterval] = useState(bill?.recurrence?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(
    parseList(bill?.recurrence?.byWeekday),
  );
  const [monthdays, setMonthdays] = useState<number[]>(
    parseList(bill?.recurrence?.byMonthday),
  );
  const [until, setUntil] = useState(
    bill?.recurrence?.until ? dateValue(new Date(bill.recurrence.until)) : '',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const recurrence =
        repeat === 'none'
          ? bill
            ? null
            : undefined
          : {
              kind: repeat,
              interval,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              until: until ? new Date(`${until}T12:00:00`).toISOString() : null,
              ...(repeat === 'weekly' && weekdays.length > 0
                ? { byWeekday: weekdays }
                : {}),
              ...(repeat === 'monthly' && monthdays.length > 0
                ? { byMonthday: monthdays }
                : {}),
            };
      const payload = {
        name: name.trim(),
        amount: Number(amount) || 0,
        dueDate: dueDate ? new Date(`${dueDate}T12:00`).toISOString() : null,
        category: category.trim() || null,
        autoPay,
        notes: notes.trim() || null,
        assignedUserId: assignedUserId || null,
        recurrence,
      };
      return bill
        ? apiFetch('/api/bills/update', {
            method: 'POST',
            body: JSON.stringify({ id: bill.id, ...payload }),
          })
        : apiFetch('/api/bills', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
    },
    onSuccess: onSaved,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Failed to save bill'),
  });

  const canSubmit = name.trim() && Number(amount) >= 0 && amount !== '';

  return (
    <Dialog
      open
      onClose={onClose}
      title={bill ? 'Edit bill' : 'New bill'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {/* Lives outside the <form> element (Dialog footer), hence form="…". */}
          <Button
            type="submit"
            form="bill-form"
            disabled={save.isPending || !canSubmit}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <form
        id="bill-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit && !save.isPending) save.mutate();
        }}
      >
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bill-name">Name</Label>
            <Input
              id="bill-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Electric"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-amount">Amount</Label>
            <Input
              id="bill-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-due">Due date</Label>
            <Input
              id="bill-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-category">Category</Label>
            <Input
              id="bill-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Utilities"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-assignee">Responsible</Label>
            <Select
              id="bill-assignee"
              value={assignedUserId}
              onChange={(e) => setAssignedUserId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bill-repeat" className="flex items-center gap-1.5">
              <Repeat className="size-3.5" /> Repeats
            </Label>
            <Select
              id="bill-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Repeat)}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </div>
          {repeat !== 'none' ? (
            <div className="space-y-1.5">
              <Label htmlFor="bill-interval">Every</Label>
              <Input
                id="bill-interval"
                type="number"
                min={1}
                max={365}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value) || 1)}
              />
            </div>
          ) : null}
          {repeat === 'weekly' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>On days (optional)</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {WEEKDAY_LABELS.map((label, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setWeekdays((p) => toggleIn(p, day))}
                    className={`size-9 rounded-md border text-sm font-medium transition-colors ${
                      weekdays.includes(day)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {repeat === 'monthly' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>On days of month (optional)</Label>
              <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setMonthdays((p) => toggleIn(p, day))}
                    className={`size-8 rounded-md border text-xs font-medium transition-colors ${
                      monthdays.includes(day)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {repeat !== 'none' ? (
            <div className="space-y-1.5">
              <Label htmlFor="bill-until">Ends on (optional)</Label>
              <Input
                id="bill-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={autoPay}
            onChange={(e) => setAutoPay(e.target.checked)}
          />
          Auto-pay enabled
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="bill-notes">Notes</Label>
          <Textarea
            id="bill-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="optional"
          />
        </div>
      </form>
    </Dialog>
  );
}
