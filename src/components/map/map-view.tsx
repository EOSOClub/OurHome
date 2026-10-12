'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Home, Map as MapIcon, MapPin, Navigation, Store } from 'lucide-react';
import type { LiveCheckDTO, LiveChecksOverviewDTO, MapPlaceDTO, MemberPresenceDTO } from '@/lib/types';
import { apiFetch } from '@/lib/api';
import { MAP_PLACE_KIND_LABELS, isMapPlaceKind } from '@/lib/location';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime, useHouseholdZone } from '@/components/household-zone';
import { MAP_PLACES_KEY } from '@/components/settings/map-places-card';
import type { MapFocus } from '@/components/map/household-map';
import { LiveChecksCard } from '@/components/map/live-checks-card';
import { LIVE_CHECKS_KEY } from '@/components/profile/location-card';

// Leaflet only runs in the browser.
const HouseholdMap = dynamic(() => import('@/components/map/household-map').then((m) => m.HouseholdMap), {
  ssr: false,
  loading: () => <div className="h-[60vh] min-h-80 w-full rounded-lg border border-border bg-muted" />,
});

export const PRESENCE_KEY = ['location-presence'];
/** Not live: the phones report arriving and leaving, so once a minute is plenty. */
const REFRESH_MS = 60_000;

function PlaceIcon({ kind }: { kind: string }) {
  if (kind === 'home') return <Home className="size-4 text-[var(--color-success)]" />;
  if (kind === 'store') return <Store className="size-4 text-primary" />;
  return <MapPin className="size-4 text-muted-foreground" />;
}

export function MapView({
  initialPlaces,
  initialPresence,
  viewerSharing,
  canManagePlaces,
}: {
  initialPlaces: MapPlaceDTO[];
  initialPresence: MemberPresenceDTO[];
  /** Whether the person looking shares their own location. */
  viewerSharing: boolean;
  canManagePlaces: boolean;
}) {
  const timeZone = useHouseholdZone();
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const { data: places = initialPlaces } = useQuery({
    queryKey: MAP_PLACES_KEY,
    queryFn: () => apiFetch<MapPlaceDTO[]>('/api/map-places'),
    initialData: initialPlaces,
  });
  const { data: presence = initialPresence } = useQuery({
    queryKey: PRESENCE_KEY,
    queryFn: () => apiFetch<MemberPresenceDTO[]>('/api/location/presence'),
    initialData: initialPresence,
    refetchInterval: REFRESH_MS,
  });

  const focusOn = (target: Omit<MapFocus, 'seq'>) =>
    setFocus((prev) => ({ ...target, seq: (prev?.seq ?? 0) + 1 }));
  const placeById = new Map(places.map((p) => [p.id, p]));

  // Live checks: polled as often as the most frequent running check asks
  // its phone, and once a minute otherwise.
  const queryClient = useQueryClient();
  const { data: overview } = useQuery({
    queryKey: LIVE_CHECKS_KEY,
    queryFn: () => apiFetch<LiveChecksOverviewDTO>('/api/location/checks'),
    refetchInterval: (query) => {
      const started = query.state.data?.started ?? [];
      return started.length ? Math.min(...started.map((c) => c.intervalSec)) * 1000 : REFRESH_MS;
    },
  });
  const started = overview?.started ?? [];
  const focusOnCheck = (check: LiveCheckDTO) => {
    if (check.fix) focusOn({ lat: check.fix.lat, lng: check.fix.lng });
  };
  // Zoom to a check's first fix once; and when a check ends, its last fix
  // may now be someone's last known point, so presence is fetched again.
  const focusedRef = useRef(new Set<string>());
  const runningRef = useRef<string[]>([]);
  const startedKey = started.map((c) => `${c.id}:${c.fix ? 1 : 0}`).join(',');
  useEffect(() => {
    for (const check of started) {
      if (check.fix && !focusedRef.current.has(check.id)) {
        focusedRef.current.add(check.id);
        setFocus((prev) => ({ lat: check.fix!.lat, lng: check.fix!.lng, seq: (prev?.seq ?? 0) + 1 }));
      }
    }
    const ids = started.map((c) => c.id);
    if (runningRef.current.some((id) => !ids.includes(id))) {
      queryClient.invalidateQueries({ queryKey: PRESENCE_KEY });
    }
    runningRef.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedKey]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <MapIcon className="size-6" /> Map
        </h1>
        <p className="text-sm text-muted-foreground">
          The household&apos;s places and who is at them. Phones say when someone arrives or leaves; a live check
          shows where someone is right now, for a few minutes.
        </p>
      </div>

      {!viewerSharing ? (
        <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          You aren&apos;t sharing where you are, so you aren&apos;t on the map. Turn it on in{' '}
          <Link href="/profile" className="font-medium text-primary hover:underline">
            Profile
          </Link>
          , then set it up in the OurHome app on your phone.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <HouseholdMap places={places} presence={presence} live={started} focus={focus} timeZone={timeZone} />

        <div className="space-y-6">
          {overview && (overview.checkable.length > 0 || started.length > 0) ? (
            <LiveChecksCard overview={overview} onFocus={focusOnCheck} />
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="size-4" /> Who&apos;s where
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {presence.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nobody yet. Members show up here once they share their location and their phone has
                  reported in.
                </p>
              ) : (
                <ul className="space-y-1">
                  {presence.map((p) => {
                    const place = p.place ? placeById.get(p.place.id) : undefined;
                    const target = place
                      ? { lat: place.lat, lng: place.lng, radiusM: place.radiusM }
                      : p.point
                        ? { lat: p.point.lat, lng: p.point.lng }
                        : null;
                    return (
                      <li key={p.userId}>
                        <button
                          type="button"
                          disabled={!target}
                          onClick={() => target && focusOn(target)}
                          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm enabled:hover:bg-accent/60"
                        >
                          <span className="truncate font-medium">{p.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {p.place ? (p.place.kind === 'home' ? p.place.name : `At ${p.place.name}`) : 'Away'}
                            {' · '}
                            <RelativeTime date={p.since} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Navigation className="size-4" /> Places
                </span>
                {canManagePlaces ? (
                  <Link href="/settings#map-places" className="text-xs font-medium text-primary hover:underline">
                    Edit
                  </Link>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {places.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No places yet.{' '}
                  {canManagePlaces
                    ? 'Add home and the stores you go to in Settings → Map places.'
                    : 'Someone who manages the household can add them in Settings.'}
                </p>
              ) : (
                <ul className="space-y-1">
                  {places.map((place) => (
                    <li key={place.id}>
                      <button
                        type="button"
                        onClick={() => focusOn({ lat: place.lat, lng: place.lng, radiusM: place.radiusM })}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60"
                      >
                        <PlaceIcon kind={place.kind} />
                        <span className="min-w-0 flex-1 truncate">{place.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {isMapPlaceKind(place.kind) ? MAP_PLACE_KIND_LABELS[place.kind] : place.kind}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
