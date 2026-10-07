'use client';

import { useState } from 'react';
import { Check, ExternalLink, Loader2, Pencil, Repeat, Trash2 } from 'lucide-react';
import type { CategoryDTO, ShoppingItemDTO } from '@/lib/types';
import { canModify, hasAnyAccess, type PageAccess } from '@/lib/permissions';
import { SHOPPING_PRIORITIES, SHOPPING_PRIORITY_LABELS } from '@/lib/enums';
import { isAmazonUrl, parseAmazonLink } from '@/lib/amazon';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { LinkField } from '@/components/shopping/link-field';

export interface UpdateItemPayload {
  itemId: string;
  name?: string;
  quantity?: number;
  priority?: string;
  notes?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  estimatedPrice?: number | null;
  recurring?: boolean;
  categoryId?: string | null;
}

/** Compact link affordance: a "View on Amazon" pill (with the ASIN) for Amazon
 * listings, or the bare hostname for any other product link. */
function ItemLink({ url }: { url: string }) {
  const { href, asin } = parseAmazonLink(url);
  const amazon = isAmazonUrl(url);

  let host = href;
  try {
    host = new URL(href).hostname.replace(/^www\./, '');
  } catch {
    // leave host as the raw href if it isn't a parseable URL
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="mt-0.5 inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-primary hover:underline"
    >
      <ExternalLink className="size-3.5 shrink-0" />
      <span className="truncate">{amazon ? 'View on Amazon' : host}</span>
      {asin ? (
        <span className="shrink-0 font-normal tabular-nums text-muted-foreground">
          {asin}
        </span>
      ) : null}
    </a>
  );
}

function priorityVariant(priority: string): 'secondary' | 'destructive' | 'warning' {
  switch (priority) {
    case 'high':
      return 'destructive';
    case 'medium':
      return 'warning';
    default:
      return 'secondary';
  }
}

export function ShoppingItemRow({
  item,
  categories,
  access,
  userId,
  onToggle,
  onDelete,
  onUpdate,
  busy,
}: {
  item: ShoppingItemDTO;
  categories: CategoryDTO[];
  /** The viewer's Shopping access; own = items they added. */
  access: PageAccess;
  userId: string;
  onToggle: (item: ShoppingItemDTO) => void;
  onDelete: (item: ShoppingItemDTO) => void;
  onUpdate: (payload: UpdateItemPayload) => Promise<unknown>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { purchased } = item;
  // Ticking off isn't an edit: any Shopping access will do (matches the API).
  const canToggle = hasAnyAccess(access);
  const canEdit = canModify(access, 'edit', item.createdById, userId);
  const canDelete = canModify(access, 'delete', item.createdById, userId);

  if (editing) {
    return (
      <EditItemForm
        item={item}
        categories={categories}
        onCancel={() => setEditing(false)}
        onSave={async (payload) => {
          await onUpdate(payload);
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div className="flex items-center gap-3 py-2.5">
      <Button
        variant={purchased ? 'secondary' : 'outline'}
        size="icon"
        className="size-9 shrink-0 rounded-full"
        onClick={() => onToggle(item)}
        disabled={busy || !canToggle}
        aria-label={purchased ? 'Mark not bought' : 'Mark bought'}
        aria-pressed={purchased}
      >
        {busy ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Check className={purchased ? 'opacity-100' : 'opacity-30'} />
        )}
      </Button>

      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt=""
          className="size-9 shrink-0 rounded border border-border bg-white object-contain"
        />
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {item.category?.color ? (
            <span
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: item.category.color }}
            />
          ) : null}
          <span
            className={cn(
              'truncate font-medium',
              purchased && 'text-muted-foreground line-through',
            )}
          >
            {item.name}
          </span>
          {item.quantity > 1 ? (
            <span className="shrink-0 text-sm text-muted-foreground">
              ×{item.quantity}
            </span>
          ) : null}
        </div>
        {item.notes ? (
          <p className="truncate text-xs text-muted-foreground">{item.notes}</p>
        ) : null}
        {item.url ? <ItemLink url={item.url} /> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {item.estimatedPrice != null ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            ${item.estimatedPrice.toFixed(2)}
          </span>
        ) : null}
        {item.recurring ? (
          <Repeat className="size-3.5 text-muted-foreground" aria-label="Recurring" />
        ) : null}
        {!purchased ? (
          <Badge variant={priorityVariant(item.priority)}>{item.priority}</Badge>
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
            onClick={() => onDelete(item)}
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

function EditItemForm({
  item,
  categories,
  onCancel,
  onSave,
}: {
  item: ShoppingItemDTO;
  categories: CategoryDTO[];
  onCancel: () => void;
  onSave: (payload: UpdateItemPayload) => Promise<void>;
}) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [priority, setPriority] = useState(item.priority);
  const [categoryId, setCategoryId] = useState(item.category?.id ?? '');
  const [price, setPrice] = useState(
    item.estimatedPrice != null ? String(item.estimatedPrice) : '',
  );
  const [recurring, setRecurring] = useState(item.recurring);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [url, setUrl] = useState(item.url ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(item.imageUrl);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    const trimmedUrl = url.trim();
    const priceNum = Number.parseFloat(price);
    const payload: UpdateItemPayload = {
      itemId: item.id,
      name: name.trim(),
      quantity: Math.max(1, quantity),
      priority,
      categoryId: categoryId || null,
      recurring,
      notes: notes.trim() ? notes.trim() : null,
      url: trimmedUrl ? trimmedUrl : null,
      // Drop a stale preview image if the link was cleared.
      imageUrl: trimmedUrl ? imageUrl : null,
      estimatedPrice:
        price && Number.isFinite(priceNum) && priceNum >= 0 ? priceNum : null,
    };

    setSaving(true);
    try {
      await onSave(payload);
    } catch {
      // The parent mutation surfaces the error message; keep the form open.
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 py-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_5rem]">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-name-${item.id}`}>Name</Label>
          <Input
            id={`edit-name-${item.id}`}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-qty-${item.id}`}>Qty</Label>
          <Input
            id={`edit-qty-${item.id}`}
            type="number"
            min={1}
            max={999}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`edit-priority-${item.id}`}>Priority</Label>
          <Select
            id={`edit-priority-${item.id}`}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            {SHOPPING_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {SHOPPING_PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`edit-category-${item.id}`}>Category</Label>
          <Select
            id={`edit-category-${item.id}`}
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
        <div className="space-y-1.5">
          <Label htmlFor={`edit-price-${item.id}`}>Est. price</Label>
          <Input
            id={`edit-price-${item.id}`}
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <LinkField
        id={`edit-url-${item.id}`}
        url={url}
        imageUrl={imageUrl}
        onUrlChange={(value) => {
          setUrl(value);
          setImageUrl(null);
        }}
        onPreview={(preview) => {
          if (preview.imageUrl) setImageUrl(preview.imageUrl);
          if (preview.title && !name.trim()) setName(preview.title);
          if (preview.price != null && !price) setPrice(String(preview.price));
        }}
      />

      <div className="space-y-1.5">
        <Label htmlFor={`edit-notes-${item.id}`}>Notes</Label>
        <Input
          id={`edit-notes-${item.id}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional details…"
        />
      </div>

      <div className="flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={recurring}
            onChange={(e) => setRecurring(e.target.checked)}
            className="size-4 accent-[var(--color-primary)]"
          />
          Recurring
        </label>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
