'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CategoryAdminDTO } from '@/lib/types';
import {
  CATEGORY_KINDS,
  CATEGORY_KIND_LABELS,
  type CategoryKind,
} from '@/lib/enums';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/empty-state';

const KEY = ['categories'];

type Editing = CategoryAdminDTO | 'new' | null;

export function CategoriesCard({
  initialCategories,
}: {
  initialCategories: CategoryAdminDTO[];
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [pendingDelete, setPendingDelete] = useState<CategoryAdminDTO | null>(
    null,
  );

  const { data: categories = [] } = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<CategoryAdminDTO[]>('/api/categories'),
    initialData: initialCategories,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: KEY });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string }>('/api/categories/delete', {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Failed to delete'),
  });

  const groups = CATEGORY_KINDS.map((kind) => ({
    kind,
    items: categories.filter((c) => c.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FolderTree className="size-4" /> Categories
          </CardTitle>
          <CardDescription>
            Labels with a color for tasks, shopping, and inventory.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus /> New
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {categories.length === 0 ? (
          <EmptyState icon={FolderTree} title="No categories yet" />
        ) : (
          groups.map((group) => (
            <div key={group.kind} className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_KIND_LABELS[group.kind]}
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {group.items.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <span
                      className="size-4 shrink-0 rounded-full border border-border"
                      style={{ background: c.color ?? 'transparent' }}
                    />
                    <span className="flex-1 truncate text-sm font-medium">
                      {c.icon ? `${c.icon} ` : ''}
                      {c.name}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${c.name}`}
                      disabled={remove.isPending}
                      onClick={() => setPendingDelete(c)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </CardContent>

      {editing !== null ? (
        <CategoryDialog
          key={editing === 'new' ? 'new' : editing.id}
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        title="Delete category"
        description={
          pendingDelete ? `Delete category "${pendingDelete.name}"?` : undefined
        }
        confirmLabel="Delete"
        destructive
      />
    </Card>
  );
}

function CategoryDialog({
  category,
  onClose,
  onSaved,
}: {
  category: CategoryAdminDTO | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(category?.name ?? '');
  const [kind, setKind] = useState<CategoryKind>(
    (category?.kind as CategoryKind) ?? 'task',
  );
  const [color, setColor] = useState(category?.color ?? '#38bdf8');
  const [icon, setIcon] = useState(category?.icon ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        kind,
        color,
        icon: icon.trim() || null,
      };
      return category
        ? apiFetch<CategoryAdminDTO>('/api/categories/update', {
            method: 'POST',
            body: JSON.stringify({ id: category.id, ...body }),
          })
        : apiFetch<CategoryAdminDTO>('/api/categories', {
            method: 'POST',
            body: JSON.stringify(body),
          });
    },
    onSuccess: onSaved,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Failed to save'),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? 'Edit category' : 'New category'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending || !name.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="cat-name">Name</Label>
          <Input
            id="cat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Cleaning"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cat-kind">Used for</Label>
            <Select
              id="cat-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as CategoryKind)}
            >
              {CATEGORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CATEGORY_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-icon">Icon / emoji (optional)</Label>
            <Input
              id="cat-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="e.g. 🧹"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cat-color">Color</Label>
          <div className="flex items-center gap-2">
            <input
              id="cat-color"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded-md border border-input bg-background"
            />
            <Input
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="max-w-[10rem] font-mono"
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}
