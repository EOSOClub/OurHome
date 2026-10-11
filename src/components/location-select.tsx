'use client';

import type { PlacesDTO } from '@/lib/types';
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

/**
 * The Location picker for tasks and inventory items: each floor (the whole
 * floor, then its rooms), then rooms on no floor. Render it only when the
 * household has places.
 */
export function LocationSelect({
  id,
  places,
  value,
  onChange,
  emptyLabel,
  roomsOnly = false,
}: {
  id: string;
  places: PlacesDTO;
  value: string;
  onChange: (value: string) => void;
  /** The "" option, e.g. "Whole house". */
  emptyLabel: string;
  /** Rooms only (NFC location tags open a room, not a floor). */
  roomsOnly?: boolean;
}) {
  const floorIds = new Set(places.floors.map((f) => f.id));
  const loose = places.rooms.filter((r) => !r.floorId || !floorIds.has(r.floorId));
  const option = (r: { id: string; name: string }) => (
    <option key={r.id} value={`room:${r.id}`}>
      {r.name}
    </option>
  );
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
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
