'use client';

import { useState } from 'react';
import {
  Check,
  Loader2,
  Minus,
  Pencil,
  Plus,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react';
import type { CategoryDTO, InventoryItemDTO } from '@/lib/types';
import type { UpdateItemPayload } from '@/components/inventory/inventory-view';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

export function InventoryRow({
  item,
  categories,
  busy,
  canWrite,
  onAdjust,
  onUpdate,
  onDelete,
  onAddToShopping,
  addingToShopping,
  addedToShopping,
}: {
  item: InventoryItemDTO;
  categories: CategoryDTO[];
  busy: boolean;
  canWrite: boolean;
  onAdjust: (delta: number) => void;
  onUpdate: (payload: UpdateItemPayload) => void;
  onDelete: () => void;
  onAddToShopping: () => void;
  addingToShopping: boolean;
  addedToShopping: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');

  function applyAmount(sign: 1 | -1) {
    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    onAdjust(sign * value);
    setAmount('');
  }

  if (editing) {
    return (
      <EditForm
        item={item}
        categories={categories}
        busy={busy}
        onCancel={() => setEditing(false)}
        onSave={(payload) => {
          onUpdate(payload);
          setEditing(false);
        }}
      />
    );
  }

  const unit = item.unit ? ` ${item.unit}` : '';

  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5">
      {canWrite ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-9 rounded-full"
            onClick={() => onAdjust(-1)}
            disabled={busy || item.quantity <= 0}
            aria-label={`Remove one ${item.name}`}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Minus />}
          </Button>
          <span className="w-12 text-center text-sm font-semibold tabular-nums">
            {item.quantity}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-9 rounded-full"
            onClick={() => onAdjust(1)}
            disabled={busy}
            aria-label={`Add one ${item.name}`}
          >
            <Plus />
          </Button>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {item.category?.color ? (
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.category.color }}
            />
          ) : null}
          <span className="truncate font-medium">{item.name}</span>
          {item.isLow ? <Badge variant="warning">Low</Badge> : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {item.quantity}
          {unit}
          {item.lowThreshold > 0 ? ` · low at ${item.lowThreshold}${unit}` : ''}
        </p>
      </div>

      {canWrite ? (
        <>
          {/* Amount adjuster: inline on desktop; wraps onto its own full-width
              row on mobile (order-last + w-full) with 44px touch targets. */}
          <div className="order-last flex w-full items-center justify-end gap-1 sm:order-none sm:w-auto">
            <Input
              aria-label={`Adjust ${item.name} by amount`}
              type="number"
              step="any"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="h-11 w-16 sm:h-9"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-11 text-muted-foreground hover:text-destructive sm:size-9"
              onClick={() => applyAmount(-1)}
              disabled={busy || !amount}
              aria-label="Subtract amount"
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 text-muted-foreground hover:text-foreground sm:size-9"
              onClick={() => applyAmount(1)}
              disabled={busy || !amount}
              aria-label="Add amount"
            >
              <Plus />
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {item.isLow ? (
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-9',
                  addedToShopping
                    ? 'text-success'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={onAddToShopping}
                disabled={addingToShopping || addedToShopping}
                aria-label={
                  addedToShopping
                    ? `${item.name} added to shopping list`
                    : `Add ${item.name} to shopping list`
                }
              >
                {addingToShopping ? (
                  <Loader2 className="animate-spin" />
                ) : addedToShopping ? (
                  <Check />
                ) : (
                  <ShoppingCart />
                )}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground hover:text-foreground"
              onClick={() => setEditing(true)}
              disabled={busy}
              aria-label="Edit item"
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              disabled={busy}
              aria-label="Remove item"
            >
              <Trash2 />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function EditForm({
  item,
  categories,
  busy,
  onCancel,
  onSave,
}: {
  item: InventoryItemDTO;
  categories: CategoryDTO[];
  busy: boolean;
  onCancel: () => void;
  onSave: (payload: UpdateItemPayload) => void;
}) {
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit ?? '');
  const [lowThreshold, setLowThreshold] = useState(String(item.lowThreshold));
  const [reorderIntervalDays, setReorderIntervalDays] = useState(
    item.reorderIntervalDays !== null ? String(item.reorderIntervalDays) : '',
  );
  const [categoryId, setCategoryId] = useState(item.category?.id ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const low = Number.parseFloat(lowThreshold);
    const interval = Number.parseInt(reorderIntervalDays, 10);
    onSave({
      itemId: item.id,
      name: name.trim(),
      unit: unit.trim() ? unit.trim() : null,
      lowThreshold: Number.isFinite(low) && low >= 0 ? low : 0,
      reorderIntervalDays:
        Number.isFinite(interval) && interval > 0 ? interval : null,
      categoryId: categoryId || null,
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn('grid gap-3 py-3 sm:grid-cols-[1fr_auto_auto]')}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-name-${item.id}`}>Name</Label>
          <Input
            id={`edit-name-${item.id}`}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-unit-${item.id}`}>Unit</Label>
          <Input
            id={`edit-unit-${item.id}`}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="e.g. rolls"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-low-${item.id}`}>Low at</Label>
          <Input
            id={`edit-low-${item.id}`}
            type="number"
            step="any"
            min={0}
            value={lowThreshold}
            onChange={(e) => setLowThreshold(e.target.value)}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`edit-restock-${item.id}`}>
            Restock every (days)
          </Label>
          <Input
            id={`edit-restock-${item.id}`}
            type="number"
            step={1}
            min={1}
            value={reorderIntervalDays}
            onChange={(e) => setReorderIntervalDays(e.target.value)}
            placeholder="e.g. 14"
          />
          <p className="text-xs text-muted-foreground">
            Used to predict when you&apos;ll run out and remind you to restock.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-cat-${item.id}`}>Category</Label>
          <Select
            id={`edit-cat-${item.id}`}
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
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button type="submit" size="icon" disabled={busy || !name.trim()} aria-label="Save">
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <X />
        </Button>
      </div>
    </form>
  );
}
