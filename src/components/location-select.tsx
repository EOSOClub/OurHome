'use client';

import type * as React from 'react';
import type { PlacesDTO, TaskPlaceDTO } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';

/** "room:<id>", "floor:<id>" or "" (none): the picker's value for a place. */
export function placeValue(p: { room: { id: string } | null; floor: { id: string } | null } | null | undefined) {
  return p?.room ? `room:${p.room.id}` : p?.floor ? `floor:${p.floor.id}` : '';
}

/** The picker's value as the API's roomId / floorId. */
export function placeIds(value: string): { roomId: string | null; floorId: string | null } {
  return {
    roomId: value.startsWith('room:') ? value.slice(5) : null,
    floorId: value.startsWith('floor:') ? value.slice(6) : null,
  };
}

/** A task's places as picker values ("room:<id>" / "floor:<id>"). */
export function placeValues(places: TaskPlaceDTO[] | undefined): string[] {
  return (places ?? []).map(placeValue).filter(Boolean);
}

/** Picker values as the API's roomIds / floorIds (both [] = the whole house). */
export function placeIdLists(values: string[]): { roomIds: string[]; floorIds: string[] } {
  return {
    roomIds: values.filter((v) => v.startsWith('room:')).map((v) => v.slice(5)),
    floorIds: values.filter((v) => v.startsWith('floor:')).map((v) => v.slice(6)),
  };
}

/**
 * The Location picker for tasks, which can be in several places: toggle
 * buttons for each floor (the whole floor, then its rooms), then rooms on no
 * floor. Nothing picked = `emptyLabel` (the whole house). Render it only when
 * the household has places.
 */
export function LocationMultiSelect({
  id,
  places,
  value,
  onChange,
  emptyLabel,
}: {
  id: string;
  places: PlacesDTO;
  /** Picked places as "room:<id>" / "floor:<id>". */
  value: string[];
  onChange: (value: string[]) => void;
  emptyLabel: string;
}) {
  const floorIds = new Set(places.floors.map((f) => f.id));
  const loose = places.rooms.filter((r) => !r.floorId || !floorIds.has(r.floorId));
  const picked = new Set(value);
  const toggle = (v: string) =>
    onChange(picked.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const chip = (v: string, label: string) => (
    <button
      key={v}
      type="button"
      aria-pressed={picked.has(v)}
      onClick={() => toggle(v)}
      className={cn(
        'h-8 rounded-md border px-2.5 text-sm transition-colors',
        picked.has(v) ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent',
      )}
    >
      {label}
    </button>
  );
  const row = (title: string, chips: React.ReactNode[]) => (
    <div key={title} className="space-y-1">
      <p className="text-xs text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-1.5">{chips}</div>
    </div>
  );
  return (
    <div id={id} role="group" aria-label="Location" className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {value.length
          ? 'Tap a place again to take it off.'
          : `${emptyLabel}. Pick one or more places to narrow it down.`}
      </p>
      {places.floors.map((f) =>
        row(f.name, [
          chip(`floor:${f.id}`, `All of ${f.name}`),
          ...places.rooms.filter((r) => r.floorId === f.id).map((r) => chip(`room:${r.id}`, r.name)),
        ]),
      )}
      {loose.length
        ? row(places.floors.length ? 'Other rooms' : 'Rooms', loose.map((r) => chip(`room:${r.id}`, r.name)))
        : null}
    </div>
  );
}

/**
 * The Location picker for inventory items (one place each) and NFC location
 * tags: each floor (the whole floor, then its rooms), then rooms on no floor.
 * Render it only when the household has places.
 */
export function LocationSelect({
  id,
  places,
  value,
  onChange,
  emptyLabel,
  roomsOnly = false,
  ...aria
}: {
  id: string;
  places: PlacesDTO;
  value: string;
  onChange: (value: string) => void;
  /** The "" option, e.g. "Whole house". */
  emptyLabel: string;
  /** Rooms only (NFC location tags open a room, not a floor). */
  roomsOnly?: boolean;
  /** Marks the choice as the problem (red), read out with its note. */
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const floorIds = new Set(places.floors.map((f) => f.id));
  const loose = places.rooms.filter((r) => !r.floorId || !floorIds.has(r.floorId));
  const option = (r: { id: string; name: string }) => (
    <option key={r.id} value={`room:${r.id}`}>
      {r.name}
    </option>
  );
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
      <option value="">{emptyLabel}</option>
      {places.floors.map((f) => (
        <optgroup key={f.id} label={f.name}>
          {roomsOnly ? null : <option value={`floor:${f.id}`}>All of {f.name}</option>}
          {places.rooms.filter((r) => r.floorId === f.id).map(option)}
        </optgroup>
      ))}
      {loose.length ? (
        <optgroup label={places.floors.length ? 'Other rooms' : 'Rooms'}>{loose.map(option)}</optgroup>
      ) : null}
    </Select>
  );
}
