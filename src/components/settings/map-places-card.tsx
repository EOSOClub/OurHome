'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crosshair, Home, Loader2, MapPin, Pencil, Plus, Search, Store, Trash2 } from 'lucide-react';
import type { AddressMatchDTO, MapPlaceDTO } from '@/lib/types';
import {
  MAP_PLACE_KINDS,
  MAP_PLACE_KIND_LABELS,
  MAP_PLACE_RADIUS,
  type MapPlaceKind,
} from '@/lib/location';
import { apiFetch } from '@/lib/api';
import { PinPicker, type LatLng } from '@/components/map/pin-picker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';

export const MAP_PLACES_KEY = ['map-places'];

type ListRef = { id: string; name: string };

/** Radius choices, in metres. */
const RADIUS_CHOICES = [150, 250, 500, 1000, 2000] as const;

function radiusLabel(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

const KIND_ICONS = { home: Home, store: Store, other: MapPin } as const;

/**
 * Settings → Map places: home, stores and other spots. The Android app turns
 * them into geofences, for who is home and for shopping-list reminders at a
 * store. Shown while the Location feature is on.
 */
export function MapPlacesCard({
  initial,
  lists,
}: {
  initial: MapPlaceDTO[];
  /** The household's shopping lists; empty when Shopping is off. */
  lists: ListRef[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ place?: MapPlaceDTO } | null>(null);
  const [deleting, setDeleting] = useState<MapPlaceDTO | null>(null);

  const { data: places = initial } = useQuery({
    queryKey: MAP_PLACES_KEY,
    queryFn: () => apiFetch<MapPlaceDTO[]>('/api/map-places'),
    initialData: initial,
  });
  const listName = new Map(lists.map((l) => [l.id, l.name]));

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<MapPlaceDTO[]>('/api/map-places/delete', { method: 'POST', body: JSON.stringify({ id }) }),
    onSuccess: (next) => {
      toast.success('Map place removed');
      setDeleting(null);
      queryClient.setQueryData(MAP_PLACES_KEY, next);
    },
  });

  const hasHome = places.some((p) => p.kind === 'home');

  return (
    // The Map page's "Edit" links here.
    <Card id="map-places" className="scroll-mt-20">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="size-4" /> Map places
          </CardTitle>
          <CardDescription>
            Your home, stores and other spots. The Android app uses them to show who is home and to remind people
            about a store&apos;s shopping lists when they get there. Each member decides on their Profile whether to
            share their location.
          </CardDescription>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => setEditing({})}>
          <Plus /> Place
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {places.length === 0 ? (
          <p className="text-sm text-muted-foreground">No map places yet. Start with your home.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {places.map((p) => {
              const Icon = KIND_ICONS[p.kind as MapPlaceKind] ?? MapPin;
              const linked = p.shoppingListIds.map((id) => listName.get(id)).filter(Boolean);
              return (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {p.name}
                      <Badge variant="outline">{MAP_PLACE_KIND_LABELS[p.kind as MapPlaceKind] ?? p.kind}</Badge>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Within {radiusLabel(p.radiusM)}
                      {linked.length ? ` · reminds about ${linked.join(', ')}` : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    aria-label={`Edit ${p.name}`}
                    onClick={() => setEditing({ place: p })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {editing ? (
        <MapPlaceDialog
          place={editing.place}
          // A household has one home: offer it only when there's none (or it's this one).
          homeTaken={hasHome && editing.place?.kind !== 'home'}
          lists={lists}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setEditing(null);
            queryClient.setQueryData(MAP_PLACES_KEY, next);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!deleting}
        title={`Remove “${deleting?.name ?? ''}”?`}
        description="Phones stop watching for arrivals there. Nothing else changes."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

/** Why the browser couldn't give a location, in plain words. */
function locationError(err: GeolocationPositionError | null): string {
  if (!err) return 'This browser can’t share its location.';
  if (err.code === err.PERMISSION_DENIED) return 'Location permission was turned down. Allow it in the browser, or drop the pin by hand.';
  if (err.code === err.TIMEOUT) return 'Finding your location took too long. Try again, or drop the pin by hand.';
  return 'Your location isn’t available right now. Drop the pin by hand.';
}

function MapPlaceDialog({
  place,
  homeTaken,
  lists,
  onClose,
  onSaved,
}: {
  place?: MapPlaceDTO;
  homeTaken: boolean;
  lists: ListRef[];
  onClose: () => void;
  onSaved: (next: MapPlaceDTO[]) => void;
}) {
  const [name, setName] = useState(place?.name ?? (homeTaken ? '' : 'Home'));
  const [kind, setKind] = useState<MapPlaceKind>(
    (place?.kind as MapPlaceKind | undefined) ?? (homeTaken ? 'store' : 'home'),
  );
  const [point, setPoint] = useState<LatLng | null>(place ? { lat: place.lat, lng: place.lng } : null);
  const [radiusM, setRadiusM] = useState(place?.radiusM ?? MAP_PLACE_RADIUS.default);
  const [listIds, setListIds] = useState<string[]>(place?.shoppingListIds ?? []);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<AddressMatchDTO[] | null>(null);
  const [locating, setLocating] = useState(false);

  const kinds = MAP_PLACE_KINDS.filter((k) => k !== 'home' || !homeTaken);
  const radii = RADIUS_CHOICES.includes(radiusM as (typeof RADIUS_CHOICES)[number])
    ? RADIUS_CHOICES
    : [...RADIUS_CHOICES, radiusM].sort((a, b) => a - b);

  const search = useMutation({
    mutationFn: (q: string) => apiFetch<AddressMatchDTO[]>(`/api/map-places/search?q=${encodeURIComponent(q)}`),
    onSuccess: (found) => {
      setMatches(found);
      if (found.length === 1) setPoint({ lat: found[0].lat, lng: found[0].lng });
    },
  });

  const save = useMutation({
    mutationFn: () =>
      apiFetch<MapPlaceDTO[]>('/api/map-places', {
        method: 'POST',
        body: JSON.stringify({
          id: place?.id,
          name: name.trim(),
          kind,
          lat: point!.lat,
          lng: point!.lng,
          radiusM,
          shoppingListIds: kind === 'store' ? listIds : [],
        }),
      }),
    onSuccess: (next) => {
      toast.success(place ? 'Map place saved' : 'Map place added');
      onSaved(next);
    },
  });

  const locateMe = () => {
    if (!window.isSecureContext) {
      toast.error('Browsers only share location over HTTPS. Drop the pin by hand.');
      return;
    }
    if (!('geolocation' in navigator)) {
      toast.error(locationError(null));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      (err) => {
        setLocating(false);
        toast.error(locationError(err));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  const canSave = name.trim().length > 0 && !!point && !save.isPending;

  return (
    <Dialog open onClose={onClose} title={place ? 'Edit map place' : 'New map place'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="map-place-name">Name</Label>
            <Input
              id="map-place-name"
              autoFocus
              value={name}
              maxLength={60}
              placeholder={kind === 'store' ? 'Costco' : kind === 'home' ? 'Home' : 'School'}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="map-place-kind">Kind</Label>
            <Select
              id="map-place-kind"
              value={kind}
              onChange={(e) => {
                const next = e.target.value as MapPlaceKind;
                // The "Home" filled in for a new place isn't a store's name.
                if (!place && next !== 'home' && name === 'Home') setName('');
                setKind(next);
              }}
            >
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {MAP_PLACE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="map-place-search">Find an address</Label>
          {/* Its own row, not a nested form: Enter searches instead of saving. */}
          <div className="flex gap-2">
            <Input
              id="map-place-search"
              value={query}
              placeholder="123 Main St, Springfield"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (query.trim().length >= 3 && !search.isPending) search.mutate(query.trim());
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={query.trim().length < 3 || search.isPending}
              onClick={() => search.mutate(query.trim())}
            >
              {search.isPending ? <Loader2 className="animate-spin" /> : <Search />}
              Search
            </Button>
          </div>
          {matches && matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing found. Try fewer words, or drop the pin on the map.</p>
          ) : null}
          {matches && matches.length > 1 ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {matches.map((m) => (
                <li key={`${m.lat},${m.lng}`}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-xs hover:bg-muted"
                    onClick={() => {
                      setPoint({ lat: m.lat, lng: m.lng });
                      setMatches(null);
                    }}
                  >
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">Address search uses OpenStreetMap.</p>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>Pin</Label>
            <Button type="button" variant="ghost" size="sm" onClick={locateMe} disabled={locating}>
              {locating ? <Loader2 className="animate-spin" /> : <Crosshair />}
              Use my location
            </Button>
          </div>
          <PinPicker value={point} radiusM={radiusM} onPick={setPoint} />
          <p className="text-xs text-muted-foreground">
            {point ? 'Tap the map to move the pin.' : 'Tap the map to drop the pin.'}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="map-place-radius">Counts as there within</Label>
          <Select id="map-place-radius" value={String(radiusM)} onChange={(e) => setRadiusM(Number(e.target.value))}>
            {radii.map((m) => (
              <option key={m} value={m}>
                {radiusLabel(m)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            Phones can&apos;t tell much closer than {radiusLabel(MAP_PLACE_RADIUS.min)}. Use more for a big store or
            its parking lot.
          </p>
        </div>

        {kind === 'store' && lists.length ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Remind about these lists on arrival</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {lists.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-input"
                    checked={listIds.includes(l.id)}
                    onChange={(e) =>
                      setListIds((ids) => (e.target.checked ? [...ids, l.id] : ids.filter((id) => id !== l.id)))
                    }
                  />
                  {l.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
