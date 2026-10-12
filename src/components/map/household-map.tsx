'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { LatLngBounds, LayerGroup, Map as LeafletMap } from 'leaflet';
import type { MapPlaceDTO, MemberPresenceDTO } from '@/lib/types';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ATTRIBUTION, TILE_URL, primaryColor, themeColor } from '@/components/map/leaflet-shared';

// The household map (Map page): every map place as its circle, labelled with
// who is there, and everyone away at the point their phone left from, with
// how long ago. Not live: it shows what the server has, and the page refetches.
// Leaflet is imported inside the effect (it touches `window` when it loads).

const WORLD: [number, number] = [20, 0];
/** Close enough to see the streets around a focused place or person. */
const FOCUS_ZOOM = 16;

/** Something to zoom to; `seq` makes picking the same thing twice move again. */
export type MapFocus = { lat: number; lng: number; radiusM?: number; seq: number };

/** A label as DOM nodes: names are typed by members, never parsed as HTML. */
function labelElement(title: string, detail: string | null): HTMLElement {
  const el = document.createElement('div');
  const strong = document.createElement('div');
  strong.style.fontWeight = '600';
  strong.textContent = title;
  el.appendChild(strong);
  if (detail) {
    const small = document.createElement('div');
    small.textContent = detail;
    el.appendChild(small);
  }
  return el;
}

function placeColor(kind: string): string {
  if (kind === 'home') return themeColor('--success', 'hsl(142 71% 45%)');
  if (kind === 'store') return primaryColor();
  return themeColor('--muted-foreground', 'hsl(215 16% 47%)');
}

export function HouseholdMap({
  places,
  presence,
  focus,
  timeZone,
  className,
}: {
  places: MapPlaceDTO[];
  presence: MemberPresenceDTO[];
  focus: MapFocus | null;
  timeZone?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LayerGroup | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  // Fitted to what's on the map once; after that the viewer's pan and zoom stay.
  const fittedRef = useRef(false);
  const [ready, setReady] = useState(false);
  // "20m ago" labels move on every minute.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    void import('leaflet').then((L) => {
      const el = containerRef.current;
      if (cancelled || !el) return;
      leafletRef.current = L;
      // No tile fade-in: it runs on animation frames, which a background tab
      // (or the headless wiki-screenshot browser) never gets.
      const map = L.map(el, { zoomControl: true, attributionControl: true, fadeAnimation: false }).setView(WORLD, 2);
      L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(el);
      setReady(true);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
      fittedRef.current = false;
    };
  }, []);

  // Draw the places and people (again on every refetch and every minute).
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer) return;
    layer.clearLayers();
    const shown: LatLngBounds[] = [];

    for (const place of places) {
      const color = placeColor(place.kind);
      const here = presence.filter((p) => p.place?.id === place.id).map((p) => p.name);
      const ring = L.circle([place.lat, place.lng], {
        radius: place.radiusM,
        color,
        weight: 2,
        fillOpacity: here.length ? 0.22 : 0.08,
        interactive: false,
      }).addTo(layer);
      L.circleMarker([place.lat, place.lng], { radius: 0, opacity: 0, interactive: false })
        .bindTooltip(labelElement(place.name, here.length ? here.join(', ') : null), {
          permanent: true,
          direction: 'top',
        })
        .addTo(layer);
      shown.push(ring.getBounds());
    }

    const awayColor = themeColor('--warning', 'hsl(38 92% 50%)');
    for (const person of presence) {
      if (person.place || !person.point) continue;
      const at: [number, number] = [person.point.lat, person.point.lng];
      if (person.point.accuracyM) {
        L.circle(at, {
          radius: person.point.accuracyM,
          color: awayColor,
          weight: 1,
          fillOpacity: 0.1,
          interactive: false,
        }).addTo(layer);
      }
      L.circleMarker(at, { radius: 7, color: '#fff', weight: 2, fillColor: awayColor, fillOpacity: 1, interactive: false })
        .bindTooltip(labelElement(person.name, `Left ${formatRelativeTime(person.since, timeZone)}`), {
          permanent: true,
          direction: 'right',
          offset: [8, 0],
        })
        .addTo(layer);
      shown.push(L.latLngBounds(at, at));
    }

    if (!fittedRef.current && shown.length) {
      fittedRef.current = true;
      const all = shown.reduce((acc, b) => acc.extend(b), L.latLngBounds(shown[0].getSouthWest(), shown[0].getNorthEast()));
      map.fitBounds(all, { padding: [32, 32], maxZoom: FOCUS_ZOOM });
    }
  }, [ready, places, presence, timeZone, tick]);

  // Zoom to whatever was picked in the list.
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !focus) return;
    if (focus.radiusM) {
      // From the point itself: a circle can only measure itself once it's on a map.
      map.fitBounds(L.latLng(focus.lat, focus.lng).toBounds(focus.radiusM * 2), {
        padding: [32, 32],
        maxZoom: FOCUS_ZOOM,
      });
    } else {
      map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), FOCUS_ZOOM));
    }
  }, [ready, focus]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Map of the household's places and who is where"
      className={cn('isolate h-[60vh] min-h-80 w-full overflow-hidden rounded-lg border border-border bg-muted', className)}
    />
  );
}
