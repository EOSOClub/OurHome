'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Loader2, Plus, Search, Tag, X } from 'lucide-react';
import type {
  CategoryDTO,
  InventoryItemDTO,
  ShoppingItemDTO,
  ShoppingListDTO,
} from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { InventoryRow } from '@/components/inventory/inventory-row';

const ITEMS_KEY = ['inventory-items'];
const CATEGORIES_KEY = ['inventory-categories'];
// Shared with the Shopping page (same route + DTO shape), so a visit there
// pre-warms this cache and vice versa.
const SHOPPING_LISTS_KEY = ['shopping-lists'];

interface AddCategoryPayload {
  name: string;
  color?: string;
}

interface AddItemPayload {
  name: string;
  unit?: string;
  quantity: number;
  lowThreshold: number;
  reorderIntervalDays?: number;
  categoryId?: string;
}

export interface UpdateItemPayload {
  itemId: string;
  name?: string;
  unit?: string | null;
  lowThreshold?: number;
  reorderIntervalDays?: number | null;
  categoryId?: string | null;
}

interface ItemGroup {
  key: string;
  label: string;
  color: string | null;
  items: InventoryItemDTO[];
}

export function InventoryView({
  initialItems,
  categories: initialCategories,
  canWrite,
}: {
  initialItems: InventoryItemDTO[];
  categories: CategoryDTO[];
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<InventoryItemDTO | null>(
    null,
  );
  const [categoryToDelete, setCategoryToDelete] = useState<CategoryDTO | null>(
    null,
  );
  // Item ids already sent to the shopping list this session, to prevent dupes.
  const [addedToShopping, setAddedToShopping] = useState<Set<string>>(
    () => new Set(),
  );
  // Item whose cart tap is waiting on the first lists fetch (row spinner).
  const [resolvingShoppingItemId, setResolvingShoppingItemId] = useState<
    string | null
  >(null);
  // Item awaiting a list pick in the chooser dialog (multi-list households).
  const [shoppingChooserItem, setShoppingChooserItem] =
    useState<InventoryItemDTO | null>(null);

  const { data: items = [] } = useQuery({
    queryKey: ITEMS_KEY,
    queryFn: () => apiFetch<InventoryItemDTO[]>('/api/inventory/items'),
    initialData: initialItems,
  });

  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_KEY,
    queryFn: () => apiFetch<CategoryDTO[]>('/api/inventory/categories'),
    initialData: initialCategories,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ITEMS_KEY });

  // Errors surface via the global MutationCache toast handler in providers.tsx.
  const addItem = useMutation({
    mutationFn: (payload: AddItemPayload) =>
      apiFetch<InventoryItemDTO>('/api/inventory/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => invalidate(),
  });

  const addCategory = useMutation({
    mutationFn: (payload: AddCategoryPayload) =>
      apiFetch<CategoryDTO>('/api/inventory/categories', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });

  const deleteCategory = useMutation({
    mutationFn: (category: CategoryDTO) =>
      apiFetch<{ id: string }>('/api/inventory/categories/delete', {
        method: 'POST',
        body: JSON.stringify({ categoryId: category.id }),
      }),
    onSuccess: (_data, category) => {
      toast.success(`Deleted category “${category.name}”`);
      queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY });
      // Items in the deleted category lose their categoryId; refresh them too.
      invalidate();
    },
  });

  const adjust = useMutation({
    mutationFn: (vars: { itemId: string; delta: number }) =>
      apiFetch<InventoryItemDTO>('/api/inventory/items/adjust', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    // Optimistically apply the delta (clamped at 0, matching the service) and
    // recompute the low flag so +/- taps respond instantly — no busy spinner,
    // so rapid taps aren't blocked. Restock timestamps and the depletion
    // forecast are server-derived; the onSettled invalidate refreshes those.
    onMutate: async ({ itemId, delta }) => {
      await queryClient.cancelQueries({ queryKey: ITEMS_KEY });
      const previous = queryClient.getQueryData<InventoryItemDTO[]>(ITEMS_KEY);
      queryClient.setQueryData<InventoryItemDTO[]>(ITEMS_KEY, (old) =>
        old?.map((item) => {
          if (item.id !== itemId) return item;
          const quantity = Math.max(0, item.quantity + delta);
          return {
            ...item,
            quantity,
            isLow: item.lowThreshold > 0 && quantity <= item.lowThreshold,
          };
        }),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(ITEMS_KEY, context.previous);
      }
      // A local onError suppresses the global MutationCache toast; re-surface.
      toast.error(
        error instanceof Error ? error.message : 'Something went wrong.',
      );
    },
    onSettled: () => invalidate(),
  });

  const updateItem = useMutation({
    mutationFn: (payload: UpdateItemPayload) =>
      apiFetch<InventoryItemDTO>('/api/inventory/items/update', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onMutate: (payload) => setBusyItemId(payload.itemId),
    onSettled: () => setBusyItemId(null),
    onSuccess: () => invalidate(),
  });

  const deleteItem = useMutation({
    mutationFn: (item: InventoryItemDTO) =>
      apiFetch<{ id: string }>('/api/inventory/items/delete', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id }),
      }),
    onMutate: (item) => setBusyItemId(item.id),
    onSettled: () => setBusyItemId(null),
    onSuccess: (_data, item) => {
      toast.success(`Removed “${item.name}” from inventory`);
      invalidate();
    },
  });

  // Shopping lists, fetched lazily on the first cart tap (enabled: false) and
  // cached so the multi-list chooser opens instantly on repeat use. Shared
  // across all rows.
  const shoppingLists = useQuery({
    queryKey: SHOPPING_LISTS_KEY,
    queryFn: () => apiFetch<ShoppingListDTO[]>('/api/shopping/lists'),
    enabled: false,
  });

  // One-tap reorder: drop a low item onto the chosen shopping list.
  const addToShopping = useMutation({
    mutationFn: async (vars: {
      item: InventoryItemDTO;
      list: ShoppingListDTO;
    }) => {
      await apiFetch<ShoppingItemDTO>('/api/shopping/items', {
        method: 'POST',
        body: JSON.stringify({ listId: vars.list.id, name: vars.item.name }),
      });
      return vars.list;
    },
    onSuccess: (list, { item }) => {
      setAddedToShopping((prev) => new Set(prev).add(item.id));
      toast.success(`Added “${item.name}” to ${list.name}`);
      // The chosen list's open count changed; refresh the cached lists.
      queryClient.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY });
    },
  });

  async function handleAddToShopping(item: InventoryItemDTO) {
    let lists = shoppingLists.data;
    if (lists === undefined) {
      setResolvingShoppingItemId(item.id);
      const result = await shoppingLists.refetch();
      setResolvingShoppingItemId(null);
      lists = result.data;
      if (lists === undefined) {
        // refetch() reports failures via `error` instead of throwing; surface
        // them like the global MutationCache toast would.
        toast.error(
          result.error instanceof Error
            ? result.error.message
            : 'Something went wrong.',
        );
        return;
      }
    } else {
      // Act on the cache instantly; refresh it in the background so list
      // membership and open counts stay current across the session.
      void shoppingLists.refetch();
    }
    if (lists.length === 0) {
      toast.error(
        'No shopping list yet — create one on the Shopping page first.',
      );
      return;
    }
    if (lists.length === 1) {
      addToShopping.mutate({ item, list: lists[0] });
      return;
    }
    setShoppingChooserItem(item);
  }

  const lowCount = items.filter((i) => i.isLow).length;

  const query = search.trim().toLowerCase();
  const filtering = query !== '' || lowOnly;
  const visible = items.filter(
    (i) =>
      (!lowOnly || i.isLow) &&
      (query === '' || i.name.toLowerCase().includes(query)),
  );

  // Group by category (alphabetical, matching the categories query order),
  // with uncategorized items last. Server order within a group is preserved.
  const byCategory = new Map<string, InventoryItemDTO[]>();
  for (const item of visible) {
    const key = item.category?.id ?? '';
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(item);
    else byCategory.set(key, [item]);
  }
  const groups: ItemGroup[] = [];
  for (const c of categories) {
    const bucket = byCategory.get(c.id);
    if (bucket)
      groups.push({ key: c.id, label: c.name, color: c.color, items: bucket });
  }
  const uncategorized = byCategory.get('');
  if (uncategorized) {
    groups.push({
      key: 'uncategorized',
      label: 'Uncategorized',
      color: null,
      items: uncategorized,
    });
  }

  const affectedByCategoryDelete = categoryToDelete
    ? items.filter((i) => i.category?.id === categoryToDelete.id).length
    : 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="text-sm text-muted-foreground">
          {items.length === 0
            ? 'Track stock levels for things you keep on hand.'
            : `${items.length} item${items.length === 1 ? '' : 's'}${
                lowCount > 0 ? ` · ${lowCount} low` : ''
              }`}
        </p>
      </div>

      {canWrite ? (
        <QuickAddItem
          categories={categories}
          submitting={addItem.isPending}
          onAdd={(payload, onSuccess) => addItem.mutate(payload, { onSuccess })}
        />
      ) : null}

      {canWrite ? (
        <CategoryManager
          categories={categories}
          submitting={addCategory.isPending}
          deletingId={
            deleteCategory.isPending
              ? (deleteCategory.variables?.id ?? null)
              : null
          }
          onAdd={(payload) => addCategory.mutate(payload)}
          onDelete={(category) => setCategoryToDelete(category)}
        />
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No inventory yet"
          description={
            canWrite
              ? 'Add items above, then adjust quantities here or by scanning an NFC tag.'
              : 'Nothing is being tracked yet.'
          }
        />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search inventory"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search items…"
                className="pl-9"
              />
            </div>
            <Button
              type="button"
              variant={lowOnly ? 'secondary' : 'outline'}
              onClick={() => setLowOnly((v) => !v)}
              aria-pressed={lowOnly}
              className="shrink-0"
            >
              Low only{lowCount > 0 ? ` (${lowCount})` : ''}
            </Button>
          </div>

          {visible.length === 0 ? (
            <p className="px-1 text-sm text-muted-foreground">
              {filtering
                ? 'No items match your search.'
                : 'No items to show.'}
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <section key={group.key} aria-label={group.label}>
                  <h2 className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.color ? (
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: group.color }}
                      />
                    ) : null}
                    {group.label}
                    <span className="font-normal">({group.items.length})</span>
                  </h2>
                  <ul className="divide-y divide-border rounded-lg border border-border bg-card px-4">
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <InventoryRow
                          item={item}
                          categories={categories}
                          busy={busyItemId === item.id}
                          canWrite={canWrite}
                          onAdjust={(delta) =>
                            adjust.mutate({ itemId: item.id, delta })
                          }
                          onUpdate={(payload) => updateItem.mutate(payload)}
                          onDelete={() => setItemToDelete(item)}
                          onAddToShopping={() =>
                            void handleAddToShopping(item)
                          }
                          addingToShopping={
                            resolvingShoppingItemId === item.id ||
                            (addToShopping.isPending &&
                              addToShopping.variables?.item.id === item.id)
                          }
                          addedToShopping={addedToShopping.has(item.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <Dialog
        open={shoppingChooserItem !== null}
        onClose={() => setShoppingChooserItem(null)}
        title="Add to shopping list"
        description={
          shoppingChooserItem
            ? `Choose a list for “${shoppingChooserItem.name}”.`
            : undefined
        }
      >
        <ul className="space-y-2">
          {(shoppingLists.data ?? []).map((list) => (
            <li key={list.id}>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-between gap-3"
                onClick={() => {
                  if (shoppingChooserItem) {
                    addToShopping.mutate({ item: shoppingChooserItem, list });
                  }
                  setShoppingChooserItem(null);
                }}
              >
                <span className="truncate">{list.name}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {list.openCount} open
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </Dialog>

      <ConfirmDialog
        open={itemToDelete !== null}
        onClose={() => setItemToDelete(null)}
        onConfirm={() => {
          if (itemToDelete) deleteItem.mutate(itemToDelete);
          setItemToDelete(null);
        }}
        title="Remove item"
        description={
          itemToDelete
            ? `Remove “${itemToDelete.name}” from inventory? Its adjustment history will be lost.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
      />

      <ConfirmDialog
        open={categoryToDelete !== null}
        onClose={() => setCategoryToDelete(null)}
        onConfirm={() => {
          if (categoryToDelete) deleteCategory.mutate(categoryToDelete);
          setCategoryToDelete(null);
        }}
        title="Delete category"
        description={
          categoryToDelete
            ? affectedByCategoryDelete > 0
              ? `Delete “${categoryToDelete.name}”? ${affectedByCategoryDelete} item${
                  affectedByCategoryDelete === 1 ? '' : 's'
                } will become uncategorized.`
              : `Delete “${categoryToDelete.name}”? No items use this category.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
}

function CategoryManager({
  categories,
  submitting,
  deletingId,
  onAdd,
  onDelete,
}: {
  categories: CategoryDTO[];
  submitting: boolean;
  deletingId: string | null;
  onAdd: (payload: AddCategoryPayload) => void;
  onDelete: (category: CategoryDTO) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#fb923c');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd({ name: trimmed, color });
    setName('');
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <Tag className="size-4" />
        {open ? 'Hide categories' : 'Manage categories'}
        {categories.length > 0 ? (
          <span className="text-xs">({categories.length})</span>
        ) : null}
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {categories.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {categories.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center gap-1.5 rounded-full border border-border py-1 pl-2.5 pr-1 text-xs"
                >
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: c.color ?? 'transparent' }}
                  />
                  {c.name}
                  <button
                    type="button"
                    onClick={() => onDelete(c)}
                    disabled={deletingId === c.id}
                    aria-label={`Delete category ${c.name}`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
                  >
                    {deletingId === c.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <X className="size-3.5" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No categories yet.</p>
          )}

          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="new-category-name">New category</Label>
              <Input
                id="new-category-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Pantry"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-category-color">Color</Label>
              <input
                id="new-category-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Category color"
                className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1"
              />
            </div>
            <Button
              type="submit"
              size="icon"
              disabled={submitting || !name.trim()}
              aria-label="Add category"
            >
              {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
            </Button>
          </form>
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
  onAdd: (payload: AddItemPayload, onSuccess: () => void) => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [quantity, setQuantity] = useState('0');
  const [lowThreshold, setLowThreshold] = useState('0');
  const [reorderIntervalDays, setReorderIntervalDays] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  function reset() {
    setName('');
    setUnit('');
    setQuantity('0');
    setLowThreshold('0');
    setReorderIntervalDays('');
    setCategoryId('');
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const qty = Number.parseFloat(quantity);
    const low = Number.parseFloat(lowThreshold);
    const interval = Number.parseInt(reorderIntervalDays, 10);
    const payload: AddItemPayload = {
      name: name.trim(),
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 0,
      lowThreshold: Number.isFinite(low) && low > 0 ? low : 0,
    };
    if (unit.trim()) payload.unit = unit.trim();
    if (Number.isFinite(interval) && interval > 0)
      payload.reorderIntervalDays = interval;
    if (categoryId) payload.categoryId = categoryId;
    // The form keeps its values until the server confirms the save, so a
    // failed request doesn't throw the input away.
    onAdd(payload, reset);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex gap-2">
        <Input
          aria-label="Item name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add an item…"
        />
        <Input
          aria-label="Starting quantity"
          type="number"
          step="any"
          min={0}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-20 shrink-0"
        />
        <Button
          type="submit"
          size="icon"
          disabled={submitting || !name.trim()}
          aria-label="Add item"
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Plus />}
        </Button>
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        aria-expanded={showDetails}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {showDetails ? 'Hide options' : 'More options'}
      </button>

      {showDetails ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="qa-unit">Unit</Label>
            <Input
              id="qa-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. rolls, oz"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-low">Low at</Label>
            <Input
              id="qa-low"
              type="number"
              step="any"
              min={0}
              value={lowThreshold}
              onChange={(e) => setLowThreshold(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-restock">Restock every (days)</Label>
            <Input
              id="qa-restock"
              type="number"
              step={1}
              min={1}
              value={reorderIntervalDays}
              onChange={(e) => setReorderIntervalDays(e.target.value)}
              placeholder="e.g. 14"
            />
            <p className="text-xs text-muted-foreground">
              Used to predict when you&apos;ll run out and remind you to
              restock.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qa-category">Category</Label>
            <Select
              id="qa-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">None</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ) : null}
    </form>
  );
}
