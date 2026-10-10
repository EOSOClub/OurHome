'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Building, DoorOpen, Layers, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { FloorDTO, PlacesDTO, RoomDTO } from '@/lib/types';
import { moveId } from '@/lib/places';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';

const KEY = ['places'];

type Editing =
  | { kind: 'floor'; floor?: FloorDTO }
  | { kind: 'room'; room?: RoomDTO; floorId?: string | null }
  | null;

type Deleting = { kind: 'floor'; floor: FloorDTO } | { kind: 'room'; room: RoomDTO } | null;

/**
 * Settings → Rooms & floors: the places tasks are done in. Floors are
 * optional (a one-storey home just has rooms). Order here is the order on the
 * Tasks page's "By room" view and in every picker.
 */
export function PlacesCard({ initial }: { initial: PlacesDTO }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);

  const { data: places = initial } = useQuery({
    queryKey: KEY,
    queryFn: () => apiFetch<PlacesDTO>('/api/places'),
    initialData: initial,
  });
  // Every call answers with the whole new list.
  const apply = (next: PlacesDTO) => {
    queryClient.setQueryData(KEY, next);
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
  };

  const reorder = useMutation({
    mutationFn: (vars: { kind: 'floor' | 'room'; ids: string[] }) =>
      apiFetch<PlacesDTO>('/api/places/reorder', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: apply,
  });
  const remove = useMutation({
    mutationFn: (vars: { kind: 'floor' | 'room'; id: string }) =>
      apiFetch<PlacesDTO>('/api/places/delete', { method: 'POST', body: JSON.stringify(vars) }),
    onSuccess: (next) => {
      toast.success(deleting?.kind === 'floor' ? 'Floor removed' : 'Room removed');
      setDeleting(null);
      apply(next);
    },
  });

  const floorIds = new Set(places.floors.map((f) => f.id));
  const roomsOn = (floorId: string | null) =>
    places.rooms.filter((r) => (r.floorId && floorIds.has(r.floorId) ? r.floorId : null) === floorId);
  const looseRooms = roomsOn(null);
  const empty = places.floors.length === 0 && places.rooms.length === 0;

  const moveButtons = (kind: 'floor' | 'room', ids: string[], id: string, label: string) => {
    const i = ids.indexOf(id);
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`Move ${label} up`}
          disabled={i <= 0 || reorder.isPending}
          onClick={() => reorder.mutate({ kind, ids: moveId(ids, id, -1) })}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`Move ${label} down`}
          disabled={i === ids.length - 1 || reorder.isPending}
          onClick={() => reorder.mutate({ kind, ids: moveId(ids, id, 1) })}
        >
          <ArrowDown />
        </Button>
      </>
    );
  };

  const roomList = (rooms: RoomDTO[]) =>
    rooms.length ? (
      <ul className="divide-y divide-border">
        {rooms.map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-1.5 pl-6 pr-1">
            <DoorOpen className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-sm">{r.name}</span>
            {moveButtons('room', rooms.map((x) => x.id), r.id, r.name)}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label={`Edit ${r.name}`}
              onClick={() => setEditing({ kind: 'room', room: r })}
            >
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${r.name}`}
              onClick={() => setDeleting({ kind: 'room', room: r })}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Building className="size-4" /> Rooms &amp; floors
          </CardTitle>
          <CardDescription>
            Where tasks are done. Tasks can belong to a room or a whole floor; the Tasks page groups them in
            this order.
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing({ kind: 'floor' })}>
            <Layers /> Floor
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: 'room', floorId: places.floors[0]?.id ?? null })}>
            <Plus /> Room
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {empty ? (
          <p className="text-sm text-muted-foreground">
            No rooms yet. Add rooms (Kitchen, Garage…), and floors if your home has more than one.
          </p>
        ) : null}
        {places.floors.map((f) => (
          <div key={f.id} className="rounded-lg border border-border">
            <div className="flex items-center gap-2 px-3 py-2">
              <Layers className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-sm font-medium">{f.name}</span>
              {moveButtons('floor', places.floors.map((x) => x.id), f.id, f.name)}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={`Add a room to ${f.name}`}
                onClick={() => setEditing({ kind: 'room', floorId: f.id })}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={`Rename ${f.name}`}
                onClick={() => setEditing({ kind: 'floor', floor: f })}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${f.name}`}
                onClick={() => setDeleting({ kind: 'floor', floor: f })}
              >
                <Trash2 />
              </Button>
            </div>
            {roomList(roomsOn(f.id))}
          </div>
        ))}
        {looseRooms.length ? (
          <div className="rounded-lg border border-border">
            {places.floors.length ? (
              <p className="px-3 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Not on a floor
              </p>
            ) : null}
            {roomList(looseRooms)}
          </div>
        ) : null}
      </CardContent>

      {editing ? (
        <PlaceDialog
          editing={editing}
          floors={places.floors}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setEditing(null);
            apply(next);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        title={deleting?.kind === 'floor' ? `Remove “${deleting.floor.name}”?` : `Remove “${deleting?.room.name ?? ''}”?`}
        description={
          deleting?.kind === 'floor'
            ? 'Its rooms are kept (on no floor), and its whole-floor tasks move to the whole house.'
            : 'Its tasks move to its floor (or the whole house). No tasks are deleted.'
        }
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(
            deleting.kind === 'floor' ? { kind: 'floor', id: deleting.floor.id } : { kind: 'room', id: deleting.room.id },
          )
        }
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

function PlaceDialog({
  editing,
  floors,
  onClose,
  onSaved,
}: {
  editing: NonNullable<Editing>;
  floors: FloorDTO[];
  onClose: () => void;
  onSaved: (next: PlacesDTO) => void;
}) {
  const existing = editing.kind === 'floor' ? editing.floor : editing.room;
  const [name, setName] = useState(existing?.name ?? '');
  const [floorId, setFloorId] = useState(
    editing.kind === 'room' ? (editing.room?.floorId ?? editing.floorId ?? '') : '',
  );
  const save = useMutation({
    mutationFn: () =>
      apiFetch<PlacesDTO>(editing.kind === 'floor' ? '/api/places/floors' : '/api/places/rooms', {
        method: 'POST',
        body: JSON.stringify(
          editing.kind === 'floor'
            ? { id: existing?.id, name: name.trim() }
            : { id: existing?.id, name: name.trim(), floorId: floorId || null },
        ),
      }),
    onSuccess: onSaved,
  });
  const noun = editing.kind === 'floor' ? 'floor' : 'room';
  return (
    <Dialog open onClose={onClose} title={existing ? `Edit ${noun}` : `New ${noun}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !save.isPending) save.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="place-name">Name</Label>
          <Input
            id="place-name"
            autoFocus
            value={name}
            maxLength={60}
            placeholder={editing.kind === 'floor' ? 'Upstairs' : 'Kitchen'}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {editing.kind === 'room' && floors.length ? (
          <div className="space-y-1.5">
            <Label htmlFor="place-floor">Floor</Label>
            <Select id="place-floor" value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              <option value="">Not on a floor</option>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
