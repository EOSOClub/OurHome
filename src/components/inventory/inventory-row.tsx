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
import type { CategoryDTO, InventoryItemDTO, PlacesDTO } from '@/lib/types';
import { canModify, hasAnyAccess, type PageAccess } from '@/lib/permissions';
import type { UpdateItemPayload } from '@/components/inventory/inventory-view';
import { LocationSelect, placeIds, placeValue } from '@/components/location-select';
import { placeLabel } from '@/lib/places';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';

export function InventoryRow({
  item,
  categories,
  places,
  hidePlace = false,
  busy,
  access,
  userId,
  canAddToShopping,
  onAdjust,
  onUpdate,
  onDelete,
  onAddToShopping,
  addingToShopping,
  addedToShopping,
}: {
  item: InventoryItemDTO;
  categories: CategoryDTO[];
  places: PlacesDTO;
  /** Under its room's heading already ("By room"): don't repeat the place. */
  hidePlace?: boolean;
  busy: boolean;
  /** The viewer's Inventory access; own = items they added. */
  access: PageAccess;
  userId: string;
  /** Viewer may add to shopping lists (Shopping "Add"). */
  canAddToShopping: boolean;
  onAdjust: (delta: number) => void;
  /** Resolves once saved; rejects when refused (the edit form stays open, marked). */
  onUpdate: (payload: UpdateItemPayload) => Promise<unknown>;
  onDelete: () => void;
  onAddToShopping: () => void;
  addingToShopping: boolean;
  addedToShopping: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  // Using up / restocking isn't an edit: any Inventory access will do.
  const canAdjust = hasAnyAccess(access);
  const canEdit = canModify(access, 'edit', item.createdById, userId);
  const canDelete = canModify(access, 'delete', item.createdById, userId);

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
        places={places}
        busy={busy}
        onCancel={() => setEditing(false)}
        onSave={async (payload) => {
          // Closes only once saved: a refusal leaves the form open with the field marked.
          await onUpdate(payload);
          setEditing(false);
        }}
      />
    );
  }

  const unit = item.unit ? ` ${item.unit}` : '';
  const place = hidePlace ? null : placeLabel(item);

  return (
    <div className="flex flex-wrap items-center gap-3 py-2.5">
      {canAdjust ? (
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
          {place ? ` · ${place}` : ''}
        </p>
      </div>

      {/* Amount adjuster: inline on desktop; wraps onto its own full-width
          row on mobile (order-last + w-full) with 44px touch targets. */}
      {canAdjust ? (
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
      ) : null}
          <div className="flex shrink-0 items-center gap-1">
            {item.isLow && canAddToShopping ? (
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
            {canEdit ? (
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
            ) : null}
            {canDelete ? (
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
            ) : null}
          </div>
    </div>
  );
}

function EditForm({
  item,
  categories,
  places,
  busy,
  onCancel,
  onSave,
}: {
  item: InventoryItemDTO;
  categories: CategoryDTO[];
  places: PlacesDTO;
  busy: boolean;
  onCancel: () => void;
  /** Resolves once saved; rejects when refused. */
  onSave: (payload: UpdateItemPayload) => Promise<unknown>;
}) {
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit ?? '');
  const [lowThreshold, setLowThreshold] = useState(String(item.lowThreshold));
  const [reorderIntervalDays, setReorderIntervalDays] = useState(
    item.reorderIntervalDays !== null ? String(item.reorderIntervalDays) : '',
  );
  const [categoryId, setCategoryId] = useState(item.category?.id ?? '');
  const [location, setLocation] = useState(placeValue(item));
  const hasPlaces = places.floors.length > 0 || places.rooms.length > 0;
  const fe = useFieldErrors(`inv-edit-${item.id}`);

  async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) return;
    const low = Number.parseFloat(lowThreshold);
    const interval = Number.parseInt(reorderIntervalDays, 10);
    try {
      await onSave({
        itemId: item.id,
        name: name.trim(),
        unit: unit.trim() ? unit.trim() : null,
        lowThreshold: Number.isFinite(low) && low >= 0 ? low : 0,
        reorderIntervalDays:
          Number.isFinite(interval) && interval > 0 ? interval : null,
        categoryId: categoryId || null,
        // Without places there's no picker: leave the stored place alone.
        ...(hasPlaces ? placeIds(location) : {}),
      });
    } catch (err) {
      // The global toast says why; mark the fields it names.
      fe.mark(err);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn('grid gap-3 py-3 sm:grid-cols-[1fr_auto_auto]')}
      {...fe.formProps}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5" data-field="name">
          <Label htmlFor={`edit-name-${item.id}`}>Name</Label>
          <Input
            id={`edit-name-${item.id}`}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...fe.invalid('name')}
          />
          <FieldNote id={fe.noteId('name')} error={fe.get('name')} />
        </div>
        <div className="space-y-1.5" data-field="unit">
          <Label htmlFor={`edit-unit-${item.id}`}>Unit</Label>
          <Input
            id={`edit-unit-${item.id}`}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="e.g. rolls"
            {...fe.invalid('unit')}
          />
          <FieldNote id={fe.noteId('unit')} error={fe.get('unit')} />
        </div>
        <div className="space-y-1.5" data-field="lowThreshold">
          <Label htmlFor={`edit-low-${item.id}`}>Low at</Label>
          <Input
            id={`edit-low-${item.id}`}
            type="number"
            step="any"
            min={0}
            value={lowThreshold}
            onChange={(e) => setLowThreshold(e.target.value)}
            {...fe.invalid('lowThreshold')}
          />
          <FieldNote id={fe.noteId('lowThreshold')} error={fe.get('lowThreshold')} />
        </div>
        <div className="space-y-1.5 sm:col-span-2" data-field="reorderIntervalDays">
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
            {...fe.invalid('reorderIntervalDays')}
          />
          <FieldNote
            id={fe.noteId('reorderIntervalDays')}
            error={fe.get('reorderIntervalDays')}
            hint="Used to predict when you'll run out and remind you to restock."
          />
        </div>
        <div className="space-y-1.5" data-field="categoryId">
          <Label htmlFor={`edit-cat-${item.id}`}>Category</Label>
          <Select
            id={`edit-cat-${item.id}`}
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
        {hasPlaces ? (
          <div className="space-y-1.5" data-field="roomId floorId">
            <Label htmlFor={`edit-location-${item.id}`}>Kept in</Label>
            <LocationSelect
              id={`edit-location-${item.id}`}
              places={places}
              value={location}
              onChange={setLocation}
              emptyLabel="Not set"
              {...fe.invalid('roomId', 'floorId')}
            />
            <FieldNote id={fe.noteId('roomId')} error={fe.first('roomId', 'floorId')} />
          </div>
        ) : null}
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
