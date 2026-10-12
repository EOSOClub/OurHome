'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { Circle, CircleMarker, Map as LeafletMap } from 'leaflet';
import { cn } from '@/lib/utils';
import { ATTRIBUTION, TILE_URL, primaryColor } from '@/components/map/leaflet-shared';

// A map to drop a pin on (Settings → Map places). Leaflet with OpenStreetMap
// tiles: free, no API key. Leaflet touches `window` when it loads, so it's
// imported inside the effect, on the client only. The pin is a drawn circle,
// not Leaflet's image marker (whose image paths bundlers break).

/** No pin yet: the whole world. */
const WORLD: [number, number] = [20, 0];
const PIN_ZOOM = 16;

export type LatLng = { lat: number; lng: number };

export function PinPicker({
  value,
  radiusM,
  onPick,
  className,
}: {
  /** null = no pin yet. */
  value: LatLng | null;
  radiusM: number;
  onPick: (point: LatLng) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const pinRef = useRef<{ dot: CircleMarker; ring: Circle } | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  // The point the pin was last drawn at, to tell a click from an outside move.
  const shownRef = useRef<LatLng | null>(null);
  // Latest callback and props, read by the map's handlers and the first draw.
  const onPickRef = useRef(onPick);
  const propsRef = useRef({ value, radiusM });
  useEffect(() => {
    onPickRef.current = onPick;
    propsRef.current = { value, radiusM };
  });

  /** Draw (or move) the pin; pan to it when it moved from outside the map. */
  const drawPin = (point: LatLng | null, radius: number, pan: boolean) => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    if (!point) {
      pinRef.current?.dot.remove();
      pinRef.current?.ring.remove();
      pinRef.current = null;
      shownRef.current = null;
      return;
    }
    const color = primaryColor();
    if (!pinRef.current) {
      pinRef.current = {
        ring: L.circle(point, { radius, color, weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map),
        dot: L.circleMarker(point, { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(map),
      };
    } else {
      pinRef.current.ring.setLatLng(point).setRadius(radius);
      pinRef.current.dot.setLatLng(point);
    }
    const prev = shownRef.current;
    shownRef.current = point;
    if (pan && (!prev || prev.lat !== point.lat || prev.lng !== point.lng)) {
      map.setView(point, Math.max(map.getZoom(), PIN_ZOOM));
    }
  };

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    void import('leaflet').then((L) => {
      const el = containerRef.current;
      if (cancelled || !el) return;
      leafletRef.current = L;
      const { value: start, radiusM: startRadius } = propsRef.current;
      // No tile fade-in: it runs on animation frames, which a background tab
      // (or the headless wiki-screenshot browser) never gets, leaving the
      // tiles invisible.
      const map = L.map(el, { zoomControl: true, attributionControl: true, fadeAnimation: false }).setView(
        start ?? WORLD,
        start ? PIN_ZOOM : 2,
      );
      L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
      map.on('click', (e) => {
        const point = { lat: e.latlng.lat, lng: e.latlng.lng };
        // Drawn here without panning; the prop update that follows is a no-op.
        drawPin(point, propsRef.current.radiusM, false);
        onPickRef.current(point);
      });
      mapRef.current = map;
      drawPin(start, startRadius, false);
      // Opened in a dialog, the box may still be settling: keep tiles filled.
      observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(el);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      pinRef.current = null;
      shownRef.current = null;
    };
  }, []);

  // Follow the pin and radius when they change outside the map (search,
  // "Use my location", the radius field). A new radius zooms out to show the
  // whole circle when it no longer fits.
  const radiusRef = useRef(radiusM);
  useEffect(() => {
    drawPin(value, radiusM, true);
    const ring = pinRef.current?.ring;
    const map = mapRef.current;
    if (radiusRef.current !== radiusM && ring && map && !map.getBounds().contains(ring.getBounds())) {
      map.fitBounds(ring.getBounds(), { padding: [16, 16] });
    }
    radiusRef.current = radiusM;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.lat, value?.lng, radiusM]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Map: tap to place the pin"
      className={cn('isolate h-64 w-full overflow-hidden rounded-lg border border-border bg-muted', className)}
    />
  );
}
