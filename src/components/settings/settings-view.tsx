'use client';

import { useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2, Plus, Tag, Trash2 } from 'lucide-react';
import type {
  CategoryAdminDTO,
  IntegrationDTO,
  NfcTagDTO,
  PointsSettingsDTO,
} from '@/lib/types';
import {
  NFC_REPRESENTS,
  NFC_REPRESENTS_LABELS,
  type NfcRepresents,
} from '@/lib/enums';
import { apiFetch } from '@/lib/api';
import { CategoriesCard } from '@/components/settings/categories-card';
import { PaperlessCard } from '@/components/settings/paperless-card';
import { useHouseholdFeatures } from '@/components/household-features';
import { PLACES_KEY, PlacesCard } from '@/components/settings/places-card';
import { LocationSelect } from '@/components/location-select';
import { placesEnabled } from '@/lib/features';
import type { MapPlaceDTO, PlacesDTO } from '@/lib/types';
import { MapPlacesCard } from '@/components/settings/map-places-card';
import { LiveCheckCard } from '@/components/settings/live-check-card';
import type { LiveCheckSettings } from '@/lib/location';
import { ExportCard } from '@/components/settings/export-card';
import { PointsCard } from '@/components/settings/points-card';
import { Button, type ButtonProps } from '@/components/ui/button';
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/empty-state';
import { useHouseholdZone } from '@/components/household-zone';

type ItemRef = { id: string; name: string };

const INTEGRATIONS_KEY = ['integrations'];
const TAGS_KEY = ['nfc-tags'];

/** Copies `text` to the clipboard with a transient "Copied" state. */
function CopyButton({
  text,
  label,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  text: string;
  label: string;
} & Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={!text}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error('Could not copy to the clipboard.');
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

export function SettingsView({
  canExport,
  initialIntegrations,
  initialTags,
  initialCategories,
  initialPoints,
  initialLiveChecks,
  initialPlaces,
  initialMapPlaces,
  shoppingLists,
  items,
}: {
  /** null unless the viewer is the Head of House. */
  initialLiveChecks: LiveCheckSettings | null;
  initialPlaces: PlacesDTO;
  initialMapPlaces: MapPlaceDTO[];
  /** For linking stores on the map to lists. */
  shoppingLists: ItemRef[];
  /** Head of House: may download the household export. */
  canExport: boolean;
  /** null unless the viewer is the Head of House. */
  /** null unless the viewer is the Head of House. */
  initialPoints: PointsSettingsDTO | null;
  initialIntegrations: IntegrationDTO[];
  initialTags: NfcTagDTO[];
  initialCategories: CategoryAdminDTO[];
  items: ItemRef[];
}) {
  // Paperless feeds Bills and NFC tags drive Inventory: hidden with them.
  const features = useHouseholdFeatures();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage categories, connect Home Assistant, and map NFC tags.
        </p>
      </div>
      {initialPoints ? <PointsCard initial={initialPoints} /> : null}
      {/* Rooms are where tasks are done and stock is kept: shown while either is on. */}
      {placesEnabled(features) ? <PlacesCard initial={initialPlaces} /> : null}
      {features.includes('location') ? (
        <MapPlacesCard
          initial={initialMapPlaces}
          lists={features.includes('shopping') ? shoppingLists : []}
        />
      ) : null}
      {features.includes('location') && initialLiveChecks ? <LiveCheckCard initial={initialLiveChecks} /> : null}
      <CategoriesCard initialCategories={initialCategories} />
      {features.includes('bills') ? <PaperlessCard /> : null}
      <HomeAssistantCard initialIntegrations={initialIntegrations} />
      {features.includes('inventory') ? (
        <NfcTagsCard initialTags={initialTags} items={items} initialPlaces={initialPlaces} />
      ) : null}
      {canExport ? <ExportCard /> : null}
    </div>
  );
}

function HomeAssistantCard({
  initialIntegrations,
}: {
  initialIntegrations: IntegrationDTO[];
}) {
  const timeZone = useHouseholdZone();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<IntegrationDTO | null>(
    null,
  );

  // Resolve the absolute webhook URL on the client; falls back to the relative
  // path during SSR (no hydration mismatch - see useSyncExternalStore docs).
  const webhookUrl = useSyncExternalStore(
    () => () => {},
    () => `${window.location.origin}/api/webhooks/nfc`,
    () => '/api/webhooks/nfc',
  );

  const { data: integrations = [] } = useQuery({
    queryKey: INTEGRATIONS_KEY,
    queryFn: () => apiFetch<IntegrationDTO[]>('/api/integrations'),
    initialData: initialIntegrations,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });

  const create = useMutation({
    mutationFn: (payload: { name: string }) =>
      apiFetch<{ integration: IntegrationDTO; token: string }>(
        '/api/integrations',
        { method: 'POST', body: JSON.stringify(payload) },
      ),
    onSuccess: (result) => {
      setName('');
      setNewToken(result.token);
      invalidate();
    },
    // Errors surface via the global mutation-error toast.
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string }>('/api/integrations/delete', {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
    onSuccess: () => {
      toast.success('Token revoked');
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Home Assistant connection
        </CardTitle>
        <CardDescription>
          Create a token, then have Home Assistant POST scans to{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{webhookUrl}</code>{' '}
          <CopyButton
            text={webhookUrl}
            label="Copy webhook URL"
            variant="ghost"
            className="h-6 gap-1 px-1.5 align-middle text-xs text-muted-foreground"
          />{' '}
          with an <code className="rounded bg-muted px-1 py-0.5 text-xs">Authorization: Bearer</code> header.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {newToken ? (
          <div className="space-y-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3">
            <p className="text-xs font-medium text-foreground">
              Copy this token now - it won’t be shown again:
            </p>
            <code className="block break-all rounded bg-background px-2 py-1.5 text-xs">
              {newToken}
            </code>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={newToken} label="Copy token" />
              <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>
                Done
              </Button>
            </div>
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name: name.trim() });
          }}
          className="flex gap-2"
        >
          <Input
            aria-label="Connection name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Home Assistant (LAN)"
          />
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            Create token
          </Button>
        </form>

        {integrations.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No connections yet"
            description="Create a token to let Home Assistant post scans here."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {integrations.map((i) => (
              <li
                key={i.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{i.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.active ? 'Active' : 'Inactive'} · created{' '}
                    {new Date(i.createdAt).toLocaleDateString(undefined, { timeZone })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground hover:text-destructive"
                  onClick={() => setPendingRevoke(i)}
                  disabled={remove.isPending && remove.variables === i.id}
                  aria-label={`Revoke ${i.name}`}
                >
                  {remove.isPending && remove.variables === i.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) remove.mutate(pendingRevoke.id);
          setPendingRevoke(null);
        }}
        title="Revoke token"
        description={
          pendingRevoke
            ? `Revoke “${pendingRevoke.name}”? This breaks every automation using it.`
            : undefined
        }
        confirmLabel="Revoke"
        destructive
      />
    </Card>
  );
}

function NfcTagsCard({
  initialTags,
  items,
  initialPlaces,
}: {
  initialTags: NfcTagDTO[];
  items: ItemRef[];
  initialPlaces: PlacesDTO;
}) {
  const queryClient = useQueryClient();
  const [tagId, setTagId] = useState('');
  const [label, setLabel] = useState('');
  const [itemId, setItemId] = useState(items[0]?.id ?? '');
  // "room:<id>" or "" - the room a location tag opens.
  const [room, setRoom] = useState('');
  const [represents, setRepresents] = useState<NfcRepresents>('consumable');
  const [pendingDelete, setPendingDelete] = useState<NfcTagDTO | null>(null);

  const { data: tags = [] } = useQuery({
    queryKey: TAGS_KEY,
    queryFn: () => apiFetch<NfcTagDTO[]>('/api/nfc/tags'),
    initialData: initialTags,
  });
  // Shared with Rooms & floors above, so a new room shows here at once.
  const { data: places = initialPlaces } = useQuery({
    queryKey: PLACES_KEY,
    queryFn: () => apiFetch<PlacesDTO>('/api/places'),
    initialData: initialPlaces,
  });
  // Location tags open a room; every other kind is bound to an item.
  const isLocation = represents === 'location';

  const invalidate = () => queryClient.invalidateQueries({ queryKey: TAGS_KEY });

  const register = useMutation({
    mutationFn: (payload: {
      tagId: string;
      label: string;
      itemId?: string;
      roomId?: string;
      represents: NfcRepresents;
    }) =>
      apiFetch<NfcTagDTO>('/api/nfc/tags', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setTagId('');
      setLabel('');
      invalidate();
    },
    // Errors surface via the global mutation-error toast.
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string }>('/api/nfc/tags/delete', {
        method: 'POST',
        body: JSON.stringify({ id }),
      }),
    onSuccess: () => {
      toast.success('Tag removed');
      invalidate();
    },
  });

  const roomId = room.startsWith('room:') ? room.slice(5) : '';
  const canSubmit = tagId.trim() && label.trim() && (isLocation ? roomId : itemId);
  const hasRooms = places.rooms.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tag className="size-4" /> NFC tags
        </CardTitle>
        <CardDescription>
          Bind each scanned tag id to an inventory item (the scan amount comes
          from Home Assistant each time), or make it a location tag: scanning
          it with the Android app opens that room&apos;s tasks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.length === 0 && !hasRooms ? (
          <p className="text-sm text-muted-foreground">
            Add inventory items (or rooms, in Rooms &amp; floors) first, then
            map tags to them here.
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit)
                register.mutate({
                  tagId: tagId.trim(),
                  label: label.trim(),
                  ...(isLocation ? { roomId } : { itemId }),
                  represents,
                });
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <div className="space-y-1.5">
              <Label htmlFor="tag-id">Tag id</Label>
              <Input
                id="tag-id"
                value={tagId}
                onChange={(e) => setTagId(e.target.value)}
                placeholder="e.g. pantry_coffee"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tag-label">Label</Label>
              <Input
                id="tag-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Coffee shelf"
              />
            </div>
            {isLocation ? (
              <div className="space-y-1.5">
                <Label htmlFor="tag-room">Opens room</Label>
                {hasRooms ? (
                  <LocationSelect
                    id="tag-room"
                    places={places}
                    value={room}
                    onChange={setRoom}
                    emptyLabel="Choose a room…"
                    roomsOnly
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Add a room in Rooms &amp; floors first.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="tag-item">Inventory item</Label>
                {items.length ? (
                  <Select
                    id="tag-item"
                    value={itemId}
                    onChange={(e) => setItemId(e.target.value)}
                  >
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Add an inventory item first.
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="tag-represents">Represents</Label>
              <Select
                id="tag-represents"
                value={represents}
                onChange={(e) =>
                  setRepresents(e.target.value as NfcRepresents)
                }
              >
                {NFC_REPRESENTS.map((r) => (
                  <option key={r} value={r}>
                    {NFC_REPRESENTS_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={register.isPending || !canSubmit}>
                {register.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Plus />
                )}
                Map tag
              </Button>
            </div>
          </form>
        )}

        {tags.length === 0 ? (
          <EmptyState icon={Tag} title="No tags mapped yet" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {tags.map((tag) => (
              <li
                key={tag.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{tag.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    <code className="rounded bg-muted px-1">{tag.tagId}</code>
                    {' → '}
                    {tag.represents === 'location'
                      ? tag.room
                        ? `opens ${tag.room.name}`
                        : 'no room'
                      : tag.item
                        ? tag.item.name
                        : 'unbound'}
                    {' · '}
                    {NFC_REPRESENTS_LABELS[
                      tag.represents as (typeof NFC_REPRESENTS)[number]
                    ] ?? tag.represents}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 text-muted-foreground hover:text-destructive"
                  onClick={() => setPendingDelete(tag)}
                  disabled={remove.isPending && remove.variables === tag.id}
                  aria-label={`Remove ${tag.label}`}
                >
                  {remove.isPending && remove.variables === tag.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
        title="Remove tag"
        description={
          pendingDelete
            ? `Remove tag “${pendingDelete.label}”? Scans for it will be ignored.`
            : undefined
        }
        confirmLabel="Remove"
        destructive
      />
    </Card>
  );
}
