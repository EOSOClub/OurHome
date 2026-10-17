'use client';

import { Fragment, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import type { CategoryDTO, ShoppingItemDTO, ShoppingListDTO } from '@/lib/types';
import { canModify, type PageAccess } from '@/lib/permissions';
import {
  SHOPPING_LIST_KINDS,
  SHOPPING_LIST_KIND_LABELS,
  SHOPPING_PRIORITIES,
  SHOPPING_PRIORITY_LABELS,
} from '@/lib/enums';
import { apiFetch, fieldErrors } from '@/lib/api';
import { useFieldErrors, type FieldErrorsState } from '@/lib/use-field-errors';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { FieldNote } from '@/components/ui/field-note';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { LinkField } from '@/components/shopping/link-field';
import {
  ShoppingItemRow,
  type UpdateItemPayload,
} from '@/components/shopping/shopping-item-row';

const LISTS_KEY = ['shopping-lists'];

interface AddItemPayload {
  listId: string;
  name: string;
  quantity: number;
  priority: string;
  recurring: boolean;
  categoryId?: string;
  estimatedPrice?: number;
  notes?: string;
  url?: string;
  imageUrl?: string;
}

// Removing an item waits out its Undo toast (5s) before reaching the server,
// so Undo just cancels: the original item keeps its creator, place in the list
// and purchase history. Module-level so a removal still lands after the user
// navigates to another page mid-window.
const UNDO_WINDOW_MS = 5500;
const pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();

function sendRemoval(itemId: string, keepalive = false) {
  return apiFetch<{ id: string }>('/api/shopping/items/delete', {
    method: 'POST',
    body: JSON.stringify({ itemId }),
    keepalive,
  });
}

// Closing the tab mid-window still removes what was removed.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const [itemId, timer] of pendingRemovals) {
      clearTimeout(timer);
      sendRemoval(itemId, true).catch(() => {});
    }
    pendingRemovals.clear();
  });
}

/** A refetch mid-window would bring a removed item back; keep it hidden. */
function hidePendingRemovals(lists: ShoppingListDTO[]): ShoppingListDTO[] {
  if (pendingRemovals.size === 0) return lists;
  return lists.map((list) => {
    const gone = list.items.filter((i) => pendingRemovals.has(i.id));
    if (gone.length === 0) return list;
    const goneBought = gone.filter((i) => i.purchased).length;
    return {
      ...list,
      openCount: list.openCount - (gone.length - goneBought),
      purchasedCount: list.purchasedCount - goneBought,
      items: list.items.filter((i) => !pendingRemovals.has(i.id)),
    };
  });
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

export function ShoppingView({
  initialLists,
  categories,
  access,
  listAccess,
  userId,
}: {
  initialLists: ShoppingListDTO[];
  categories: CategoryDTO[];
  /** The viewer's access to items on the lists (Members → Permissions). */
  access: PageAccess;
  /** The viewer's access to the lists themselves: new, rename, delete. */
  listAccess: PageAccess;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => searchParams.get('list') ?? initialLists[0]?.id ?? null,
  );
  const [showNewList, setShowNewList] = useState(false);
  const [renamingList, setRenamingList] = useState(false);
  const [confirmDeleteList, setConfirmDeleteList] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const { data: lists = [] } = useQuery({
    queryKey: LISTS_KEY,
    queryFn: () => apiFetch<ShoppingListDTO[]>('/api/shopping/lists'),
    initialData: initialLists,
    select: hidePendingRemovals,
  });

  // Derive the active list during render: honour the explicit selection when it
  // still exists, otherwise fall back to the first list (handles a stale or
  // null selection without syncing state in an effect).
  const selected =
    lists.find((l) => l.id === selectedId) ?? lists[0] ?? null;

  /** Select a list and mirror the choice into the URL so it survives reloads. */
  function selectList(id: string | null) {
    setSelectedId(id);
    router.replace(id ? `${pathname}?list=${id}` : pathname, { scroll: false });
  }

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: LISTS_KEY });

  // Field errors for the new-list form and the rename dialog.
  const newListForm = useFieldErrors('nl');
  const renameForm = useFieldErrors('rename-list');

  const createList = useMutation({
    mutationFn: (payload: { name: string; kind: string }) =>
      apiFetch<ShoppingListDTO>('/api/shopping/lists', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (list) => {
      setShowNewList(false);
      selectList(list.id);
      invalidate();
    },
    onError: newListForm.fail,
  });

  const renameList = useMutation({
    mutationFn: (payload: { listId: string; name: string }) =>
      apiFetch<ShoppingListDTO>('/api/shopping/lists/update', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setRenamingList(false);
      invalidate();
    },
    onError: renameForm.fail,
  });

  const deleteList = useMutation({
    mutationFn: (payload: { listId: string; name: string }) =>
      apiFetch<{ id: string }>('/api/shopping/lists/delete', {
        method: 'POST',
        body: JSON.stringify({ listId: payload.listId }),
      }),
    onSuccess: (_data, payload) => {
      setConfirmDeleteList(false);
      toast.success(`Deleted “${payload.name}”`);
      // Move the selection to whichever list remains.
      selectList(lists.find((l) => l.id !== payload.listId)?.id ?? null);
      invalidate();
    },
  });

  const addItem = useMutation({
    mutationFn: (payload: AddItemPayload) =>
      apiFetch<ShoppingItemDTO>('/api/shopping/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidate(),
  });

  const togglePurchased = useMutation({
    mutationFn: (item: ShoppingItemDTO) =>
      apiFetch<ShoppingItemDTO>('/api/shopping/items/purchase', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id, purchased: !item.purchased }),
      }),
    // Optimistically move the item between "to buy" and "in cart" so the
    // check-off feels instant; onSettled re-syncs with the server either way.
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: LISTS_KEY });
      const previous = queryClient.getQueryData<ShoppingListDTO[]>(LISTS_KEY);
      const purchased = !item.purchased;
      queryClient.setQueryData<ShoppingListDTO[]>(LISTS_KEY, (old) =>
        old?.map((list) =>
          list.id === item.listId
            ? {
                ...list,
                openCount: list.openCount + (purchased ? -1 : 1),
                purchasedCount: list.purchasedCount + (purchased ? 1 : -1),
                items: list.items.map((i) =>
                  i.id === item.id
                    ? {
                        ...i,
                        purchased,
                        purchasedAt: purchased
                          ? new Date().toISOString()
                          : null,
                      }
                    : i,
                ),
              }
            : list,
        ),
      );
      return { previous };
    },
    onError: (error, _item, context) => {
      if (context?.previous) {
        queryClient.setQueryData(LISTS_KEY, context.previous);
      }
      // A local onError suppresses the global MutationCache toast; re-surface.
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: () => invalidate(),
  });

  // Deleting a single item is low-stakes, so skip the confirm dialog: hide it
  // at once and only send the delete once the Undo window has passed.
  function removeItem(item: ShoppingItemDTO) {
    if (pendingRemovals.has(item.id)) return;
    const timer = setTimeout(() => {
      pendingRemovals.delete(item.id);
      sendRemoval(item.id)
        .catch((error) => {
          // The refetch below brings the item back.
          toast.error(error instanceof Error ? error.message : 'Something went wrong.');
        })
        .finally(() => invalidate());
    }, UNDO_WINDOW_MS);
    pendingRemovals.set(item.id, timer);
    queryClient.setQueryData<ShoppingListDTO[]>(LISTS_KEY, (old) => old && [...old]);
    toast.info(`Removed “${item.name}”`, {
      label: 'Undo',
      onClick: () => {
        const pending = pendingRemovals.get(item.id);
        if (!pending) return;
        clearTimeout(pending);
        pendingRemovals.delete(item.id);
        queryClient.setQueryData<ShoppingListDTO[]>(LISTS_KEY, (old) => old && [...old]);
      },
    });
  }

  const clearPurchased = useMutation({
    mutationFn: (payload: { listId: string; count: number }) =>
      apiFetch<ShoppingListDTO>('/api/shopping/lists/clear', {
        method: 'POST',
        body: JSON.stringify({ listId: payload.listId }),
      }),
    onSuccess: (_data, payload) => {
      setConfirmClear(false);
      toast.success(`Cleared ${payload.count} bought item${plural(payload.count)}`);
      invalidate();
    },
  });

  const updateItem = useMutation({
    mutationFn: (payload: UpdateItemPayload) =>
      apiFetch<ShoppingItemDTO>('/api/shopping/items/update', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidate(),
  });

  // Per-row pending derived from each mutation's variables so only the row the
  // user actually tapped shows a spinner (a shared "busy id" state would mark
  // whichever row was tapped last during concurrent mutations). Purchase
  // toggles and deletes patch the cache optimistically, so they don't mark
  // the row busy.
  const busyItemId =
    (updateItem.isPending ? updateItem.variables?.itemId : undefined) ?? null;

  const openItems = selected?.items.filter((i) => !i.purchased) ?? [];
  // Est. price is per item (a fetched product page gives a unit price).
  const estTotal = openItems.reduce((sum, i) => sum + (i.estimatedPrice ?? 0) * i.quantity, 0);
  const unpricedCount = openItems.filter((i) => i.estimatedPrice == null).length;
  // What Clear bought will actually clear: recurring items (un-checked) plus the
  // one-off items the viewer may delete, as the clear route decides.
  const clearable =
    selected?.items.filter(
      (i) => i.purchased && (i.recurring || canModify(access, 'delete', i.createdById, userId)),
    ).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Shopping</h1>
          <p className="text-sm text-muted-foreground">
            {selected
              ? `${selected.openCount} to buy · ${selected.purchasedCount} in cart` +
                (openItems.length > 0
                  ? ` · Est. total ${formatMoney(estTotal)}` +
                    (unpricedCount > 0 ? ` + ${unpricedCount} unpriced` : '')
                  : '')
              : 'Create a list to get started.'}
          </p>
        </div>
        {listAccess.create && !showNewList ? (
          <Button
            variant="outline"
            onClick={() => {
              newListForm.clear();
              setShowNewList(true);
            }}
          >
            <Plus /> New list
          </Button>
        ) : null}
      </div>

      {showNewList ? (
        <NewListForm
          submitting={createList.isPending}
          errors={newListForm}
          onSubmit={(payload) => createList.mutate(payload)}
          onCancel={() => setShowNewList(false)}
        />
      ) : null}

      {lists.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              onClick={() => selectList(list.id)}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors',
                list.id === selected?.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input hover:bg-accent',
              )}
            >
              {list.name}
              {list.openCount > 0 ? (
                <span className="ml-1.5 opacity-70">{list.openCount}</span>
              ) : null}
            </button>
          ))}
          {selected ? (
            <div className="flex items-center">
              {canModify(listAccess, 'edit', selected.createdById, userId) ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    renameForm.clear();
                    setRenamingList(true);
                  }}
                  aria-label={`Rename ${selected.name}`}
                >
                  <Pencil />
                </Button>
              ) : null}
              {canModify(listAccess, 'delete', selected.createdById, userId) ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => setConfirmDeleteList(true)}
                  aria-label={`Delete ${selected.name}`}
                >
                  <Trash2 />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {selected ? (
        <ListPanel
          list={selected}
          categories={categories}
          access={access}
          userId={userId}
          adding={addItem.isPending}
          busyItemId={busyItemId}
          onAdd={(payload) =>
            addItem.mutateAsync({ ...payload, listId: selected.id })
          }
          onToggle={(item) => togglePurchased.mutate(item)}
          onDelete={removeItem}
          onUpdate={(payload) => updateItem.mutateAsync(payload)}
          onClear={() => setConfirmClear(true)}
        />
      ) : !showNewList ? (
        <EmptyState
          icon={ShoppingCart}
          title="No lists yet"
          description="Create a grocery, supplies, hardware or Amazon list to start adding items."
        />
      ) : null}

      {selected ? (
        <RenameListDialog
          key={`${selected.id}:${selected.name}`}
          open={renamingList}
          list={selected}
          pending={renameList.isPending}
          errors={renameForm}
          onClose={() => setRenamingList(false)}
          onRename={(name) =>
            renameList.mutate({ listId: selected.id, name })
          }
        />
      ) : null}

      {selected ? (
        <ConfirmDialog
          open={confirmDeleteList}
          onClose={() => setConfirmDeleteList(false)}
          onConfirm={() =>
            deleteList.mutate({ listId: selected.id, name: selected.name })
          }
          title={`Delete “${selected.name}”?`}
          description={`This permanently deletes the list and its ${selected.items.length} item${plural(selected.items.length)}.`}
          confirmLabel="Delete list"
          destructive
          pending={deleteList.isPending}
        />
      ) : null}

      {selected ? (
        <ConfirmDialog
          open={confirmClear}
          onClose={() => setConfirmClear(false)}
          onConfirm={() =>
            clearPurchased.mutate({
              listId: selected.id,
              count: clearable,
            })
          }
          title={`Clear ${clearable} bought item${plural(clearable)}?`}
          description={
            'One-off items are removed for good; recurring items are un-checked and stay on the list.' +
            (clearable < selected.purchasedCount
              ? ` ${selected.purchasedCount - clearable} you can't remove will stay in the cart.`
              : '')
          }
          confirmLabel="Clear"
          destructive
          pending={clearPurchased.isPending}
        />
      ) : null}
    </div>
  );
}

interface ItemGroup {
  key: string;
  label: string | null;
  items: ShoppingItemDTO[];
}

/** Group items by category (insertion order → alphabetical), uncategorized last. */
function groupByCategory(items: ShoppingItemDTO[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    const key = item.category?.id ?? 'uncategorized';
    const group =
      groups.get(key) ??
      ({ key, label: item.category?.name ?? null, items: [] } satisfies ItemGroup);
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.label === null) return 1;
    if (b.label === null) return -1;
    return a.label.localeCompare(b.label);
  });
}

function ListPanel({
  list,
  categories,
  access,
  userId,
  adding,
  busyItemId,
  onAdd,
  onToggle,
  onDelete,
  onUpdate,
  onClear,
}: {
  list: ShoppingListDTO;
  categories: CategoryDTO[];
  access: PageAccess;
  userId: string;
  adding: boolean;
  busyItemId: string | null;
  onAdd: (payload: Omit<AddItemPayload, 'listId'>) => Promise<unknown>;
  onToggle: (item: ShoppingItemDTO) => void;
  onDelete: (item: ShoppingItemDTO) => void;
  onUpdate: (payload: UpdateItemPayload) => Promise<unknown>;
  onClear: () => void;
}) {
  const open = list.items.filter((i) => !i.purchased);
  const purchased = list.items.filter((i) => i.purchased);
  const openGroups = groupByCategory(open);
  // Don't render a lone "Uncategorized" header when nothing is categorized.
  const showGroupHeaders =
    openGroups.length > 1 || openGroups[0]?.label != null;

  return (
    <div className="space-y-4">
      {access.create ? (
        <QuickAddItem categories={categories} submitting={adding} onAdd={onAdd} />
      ) : null}

      {list.items.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="This list is empty"
          description={
            access.create ? 'Add your first item above.' : 'Nothing to buy right now.'
          }
        />
      ) : null}

      {open.length > 0 ? (
        <div className="space-y-3">
          {openGroups.map((group) => (
            <Fragment key={group.key}>
              {showGroupHeaders ? (
                <h2 className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label ?? 'Uncategorized'}
                </h2>
              ) : null}
              <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <ShoppingItemRow
                      item={item}
                      categories={categories}
                      access={access}
                      userId={userId}
                      onToggle={onToggle}
                      onDelete={onDelete}
                      onUpdate={onUpdate}
                      busy={busyItemId === item.id}
                    />
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      ) : null}

      {purchased.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              In cart ({purchased.length})
            </h2>
            {/* Clearing removes only the bought items the viewer may delete. */}
            {access.deleteOwn || access.deleteOthers ? (
              <Button variant="ghost" size="sm" onClick={onClear}>
                Clear bought
              </Button>
            ) : null}
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
            {purchased.map((item) => (
              <li key={item.id}>
                <ShoppingItemRow
                  item={item}
                  categories={categories}
                  access={access}
                  userId={userId}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onUpdate={onUpdate}
                  busy={busyItemId === item.id}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function QuickAddItem({
  categories,
  submitting,
  onAdd,
}: {
  categories: CategoryDTO[];
  submitting: boolean;
  onAdd: (payload: Omit<AddItemPayload, 'listId'>) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [priority, setPriority] = useState('medium');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [notes, setNotes] = useState('');
  const [url, setUrl] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const fe = useFieldErrors('qa');
  // A refused option is hidden under "More options": open them so it can be seen.
  const detailKeys = ['priority', 'categoryId', 'estimatedPrice', 'notes', 'url', 'imageUrl'];

  function reset() {
    setName('');
    setQuantity(1);
    setPriority('medium');
    setCategoryId('');
    setPrice('');
    setRecurring(false);
    setNotes('');
    setUrl('');
    setImageUrl(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const payload: Omit<AddItemPayload, 'listId'> = {
      name: name.trim(),
      quantity: Math.max(1, quantity),
      priority,
      recurring,
    };
    if (categoryId) payload.categoryId = categoryId;
    if (notes.trim()) payload.notes = notes.trim();
    if (url.trim()) payload.url = url.trim();
    if (url.trim() && imageUrl) payload.imageUrl = imageUrl;
    const priceNum = Number.parseFloat(price);
    if (price && Number.isFinite(priceNum) && priceNum >= 0) {
      payload.estimatedPrice = priceNum;
    }
    try {
      await onAdd(payload);
      // Only clear the form once the item is saved so a failed add keeps the
      // user's input for a retry.
      reset();
      fe.clear();
    } catch (err) {
      // The global mutation error handler says why; mark the fields it names.
      fe.mark(err);
      if (Object.keys(fieldErrors(err)).some((k) => detailKeys.includes(k))) setShowDetails(true);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
      {...fe.formProps}
    >
      <div className="flex gap-2">
        <div className="min-w-0 flex-1" data-field="name">
          <Input
            aria-label="Item name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="Add an item…"
            {...fe.invalid('name')}
          />
        </div>
        <div className="shrink-0" data-field="quantity">
          <Input
            aria-label="Quantity"
            type="number"
            min={1}
            max={999}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
            className="w-16"
            {...fe.invalid('quantity')}
          />
        </div>
        <Button
          type="submit"
          size="icon"
          aria-label="Add item"
          disabled={submitting || !name.trim()}
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
        </Button>
      </div>
      <FieldNote id={fe.noteId('name')} error={fe.get('name')} />
      <FieldNote id={fe.noteId('quantity')} error={fe.get('quantity')} />

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {showDetails ? 'Hide options' : 'More options'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" data-field="recurring">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(e) => setRecurring(e.target.checked)}
            className="size-4 accent-[var(--color-primary)]"
          />
          Recurring
        </label>
      </div>
      <FieldNote id={fe.noteId('recurring')} error={fe.get('recurring')} />

      {showDetails ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5" data-field="priority">
            <Label htmlFor="qa-priority">Priority</Label>
            <Select
              id="qa-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              {...fe.invalid('priority')}
            >
              {SHOPPING_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {SHOPPING_PRIORITY_LABELS[p]}
                </option>
              ))}
            </Select>
            <FieldNote id={fe.noteId('priority')} error={fe.get('priority')} />
          </div>
          <div className="space-y-1.5" data-field="categoryId">
            <Label htmlFor="qa-category">Category</Label>
            <Select
              id="qa-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              {...fe.invalid('categoryId')}
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <FieldNote id={fe.noteId('categoryId')} error={fe.get('categoryId')} />
          </div>
          <div className="space-y-1.5" data-field="estimatedPrice">
            <Label htmlFor="qa-price">Est. price</Label>
            <Input
              id="qa-price"
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              {...fe.invalid('estimatedPrice')}
            />
            <FieldNote id={fe.noteId('estimatedPrice')} error={fe.get('estimatedPrice')} />
          </div>
          <div className="space-y-1.5 sm:col-span-3" data-field="notes">
            <Label htmlFor="qa-notes">Notes</Label>
            <Input
              id="qa-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional details…"
              {...fe.invalid('notes')}
            />
            <FieldNote id={fe.noteId('notes')} error={fe.get('notes')} />
          </div>
          <div className="sm:col-span-3" data-field="url imageUrl">
            <LinkField
              id="qa-url"
              url={url}
              imageUrl={imageUrl}
              error={fe.first('url', 'imageUrl')}
              onUrlChange={(value) => {
                setUrl(value);
                setImageUrl(null);
              }}
              onPreview={(preview) => {
                if (preview.imageUrl) setImageUrl(preview.imageUrl);
                if (preview.title && !name.trim()) setName(preview.title);
                if (preview.price != null && !price) {
                  setPrice(String(preview.price));
                }
              }}
            />
          </div>
        </div>
      ) : null}
    </form>
  );
}

function RenameListDialog({
  open,
  list,
  pending,
  errors,
  onClose,
  onRename,
}: {
  open: boolean;
  list: ShoppingListDTO;
  pending: boolean;
  /** The last save's field errors: the name is marked with why. */
  errors: FieldErrorsState;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(list.name);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Nothing changed: just close, rather than a Save that silently does nothing.
    if (trimmed === list.name) {
      onClose();
      return;
    }
    onRename(trimmed);
  }

  return (
    <Dialog open={open} onClose={onClose} title="Rename list">
      <form onSubmit={handleSubmit} className="space-y-4" {...errors.formProps}>
        <div className="space-y-1.5" data-field="name">
          <Label htmlFor="rename-list-name">List name</Label>
          <Input
            id="rename-list-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...errors.invalid('name')}
          />
          <FieldNote id={errors.noteId('name')} error={errors.get('name')} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewListForm({
  submitting,
  errors,
  onSubmit,
  onCancel,
}: {
  submitting: boolean;
  /** The last save's field errors: those fields are marked with why. */
  errors: FieldErrorsState;
  onSubmit: (payload: { name: string; kind: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('grocery');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({ name: name.trim(), kind });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-[1fr_auto_auto]"
      {...errors.formProps}
    >
      <div className="space-y-1.5" data-field="name">
        <Label htmlFor="nl-name">List name</Label>
        <Input
          id="nl-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Weekly groceries"
          {...errors.invalid('name')}
        />
        <FieldNote id={errors.noteId('name')} error={errors.get('name')} />
      </div>
      <div className="space-y-1.5" data-field="kind">
        <Label htmlFor="nl-kind">Type</Label>
        <Select id="nl-kind" value={kind} onChange={(e) => setKind(e.target.value)} {...errors.invalid('kind')}>
          {SHOPPING_LIST_KINDS.map((k) => (
            <option key={k} value={k}>
              {SHOPPING_LIST_KIND_LABELS[k]}
            </option>
          ))}
        </Select>
        <FieldNote id={errors.noteId('kind')} error={errors.get('kind')} />
      </div>
      <div className="flex items-end gap-2">
        <Button type="submit" disabled={submitting || !name.trim()}>
          {submitting ? <Loader2 className="animate-spin" /> : null}
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
