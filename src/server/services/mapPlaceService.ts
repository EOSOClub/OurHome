import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import { pushSync } from '@/server/services/pushService';
import { MAP_PLACE_KIND_LABELS, distanceM, isMapPlaceKind } from '@/lib/location';
import type { AddressMatchDTO, MapPlaceDTO } from '@/lib/types';
import type { DeleteMapPlaceInput, SaveMapPlaceInput } from '@/lib/validation/location';

// Map places (Settings → Map places): home, stores and other spots. The
// Android app makes each one a geofence (presence, store reminders). A
// household has at most one home, which is what "home" means for presence.

type Row = {
  id: string;
  name: string;
  kind: string;
  lat: number;
  lng: number;
  radiusM: number;
  shoppingListIds: string[];
};

/** Home first, then by name. */
function byHomeThenName(a: MapPlaceDTO, b: MapPlaceDTO): number {
  if ((a.kind === 'home') !== (b.kind === 'home')) return a.kind === 'home' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function toDTO(row: Row, listIds: Set<string>): MapPlaceDTO {
  return {
    id: row.id,
    name: row.name,
    kind: isMapPlaceKind(row.kind) ? row.kind : 'other',
    lat: row.lat,
    lng: row.lng,
    radiusM: row.radiusM,
    // A shopping list deleted since is dropped here rather than on delete.
    shoppingListIds: row.shoppingListIds.filter((id) => listIds.has(id)),
  };
}

export async function listMapPlaces(householdId: string): Promise<MapPlaceDTO[]> {
  const [rows, lists] = await Promise.all([
    prisma.mapPlace.findMany({ where: { householdId } }),
    prisma.shoppingList.findMany({ where: { householdId }, select: { id: true } }),
  ]);
  const listIds = new Set(lists.map((l) => l.id));
  return rows.map((r) => toDTO(r, listIds)).sort(byHomeThenName);
}

export async function saveMapPlace(
  householdId: string,
  actorId: string,
  input: SaveMapPlaceInput,
): Promise<MapPlaceDTO[]> {
  // Only stores remind about lists, and only this household's lists.
  let shoppingListIds: string[] = [];
  if (input.kind === 'store' && input.shoppingListIds.length) {
    const lists = await prisma.shoppingList.findMany({
      where: { householdId, id: { in: input.shoppingListIds } },
      select: { id: true },
    });
    if (lists.length !== new Set(input.shoppingListIds).size) {
      throw new NotFoundError('Shopping list not found.');
    }
    shoppingListIds = [...new Set(input.shoppingListIds)];
  }

  if (input.kind === 'home') {
    const home = await prisma.mapPlace.findFirst({
      where: { householdId, kind: 'home', ...(input.id ? { NOT: { id: input.id } } : {}) },
      select: { name: true },
    });
    if (home) throw new ConflictError(`“${home.name}” is already the home. Change that one instead.`);
  }

  const data = {
    name: input.name,
    kind: input.kind,
    lat: input.lat,
    lng: input.lng,
    radiusM: input.radiusM,
    shoppingListIds,
  };

  if (input.id) {
    const existing = await prisma.mapPlace.findFirst({ where: { id: input.id, householdId } });
    if (!existing) throw new NotFoundError('Map place not found.');
    await prisma.mapPlace.update({ where: { id: input.id }, data });
    if (existing.lat !== input.lat || existing.lng !== input.lng || existing.radiusM !== input.radiusM) {
      await clearMembersOutside(householdId, { id: input.id, lat: input.lat, lng: input.lng, radiusM: input.radiusM });
    }
    await logActivity({
      householdId,
      actorId,
      verb: 'updated',
      subjectType: 'map_place',
      subjectId: input.id,
      message:
        existing.name !== input.name
          ? `renamed the map place “${existing.name}” to “${input.name}”`
          : `changed the map place “${input.name}”`,
    });
  } else {
    const place = await prisma.mapPlace.create({ data: { householdId, createdById: actorId, ...data } });
    await logActivity({
      householdId,
      actorId,
      verb: 'created',
      subjectType: 'map_place',
      subjectId: place.id,
      message: `added the map place “${place.name}” (${MAP_PLACE_KIND_LABELS[input.kind].toLowerCase()})`,
    });
  }
  placesChanged(householdId);
  return listMapPlaces(householdId);
}

/**
 * No longer at a known place. The stored point goes too: for someone at a
 * place it's where they arrived, and kept on an away row the map would show
 * it as where they left from, at a time nobody left.
 */
const NOT_AT_A_PLACE = { state: 'away', placeId: null, lat: null, lng: null, accuracyM: null, pointAt: null };

/**
 * A place moved or shrank: anyone recorded there whose last point is now
 * outside the circle (beyond its accuracy) is no longer at it. The phone only
 * reports a dwell when it re-registers its geofences, never an exit from a
 * fence it wasn't inside, so nothing else would clear them. Anyone whose point
 * isn't known is left as they are; anyone really inside gets the dwell back.
 */
async function clearMembersOutside(
  householdId: string,
  place: { id: string; lat: number; lng: number; radiusM: number },
): Promise<void> {
  const here = await prisma.memberLocation.findMany({
    where: { householdId, placeId: place.id, state: 'place' },
    select: { userId: true, lat: true, lng: true, accuracyM: true },
  });
  const outside = here
    .filter((m) => m.lat != null && m.lng != null)
    .filter((m) => distanceM({ lat: m.lat!, lng: m.lng! }, place) > place.radiusM + (m.accuracyM ?? 0))
    .map((m) => m.userId);
  if (!outside.length) return;
  await prisma.memberLocation.updateMany({
    where: { householdId, placeId: place.id, userId: { in: outside } },
    data: NOT_AT_A_PLACE,
  });
}

/** Phones watch the map places: wake them to pick up the change now. */
function placesChanged(householdId: string): void {
  pushSync(householdId, { everyone: true }, 'map_places');
}

export async function deleteMapPlace(
  householdId: string,
  actorId: string,
  input: DeleteMapPlaceInput,
): Promise<MapPlaceDTO[]> {
  const place = await prisma.mapPlace.findFirst({ where: { id: input.id, householdId } });
  if (!place) throw new NotFoundError('Map place not found.');
  await prisma.$transaction([
    // Anyone recorded there is no longer at a known place.
    prisma.memberLocation.updateMany({
      where: { householdId, placeId: place.id },
      data: NOT_AT_A_PLACE,
    }),
    prisma.mapPlace.delete({ where: { id: place.id } }),
  ]);
  placesChanged(householdId);
  await logActivity({
    householdId,
    actorId,
    verb: 'deleted',
    subjectType: 'map_place',
    subjectId: place.id,
    message: `removed the map place “${place.name}”`,
  });
  return listMapPlaces(householdId);
}

// --- Address search ----------------------------------------------------------------
// OpenStreetMap's Nominatim, called from the server so the browser's CSP stays
// 'self' and the request carries the identifying User-Agent its usage policy
// asks for. The policy allows at most one request a second (for the whole
// server), and searching only when the user presses Search (no autocomplete).

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'OurHome (self-hosted household app; https://github.com/EOSOClub/OurHome)';
const SEARCH_TIMEOUT_MS = 8000;

/** Nominatim's jsonv2 search result, the fields used. */
type NominatimHit = { display_name?: unknown; lat?: unknown; lon?: unknown };

/** Pure: Nominatim's answer as matches; anything malformed is skipped. */
export function parseNominatim(body: unknown): AddressMatchDTO[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((hit: NominatimHit) => {
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    if (typeof hit?.display_name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return [{ label: hit.display_name, lat, lng }];
  });
}

/** The search itself; the route holds the one-a-second limit. */
export async function searchAddress(query: string): Promise<AddressMatchDTO[]> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('q', query);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Thrown into the catch below on purpose: every failure (network, timeout,
      // a bad status) ends in the same message for the person searching.
      // noinspection ExceptionCaughtLocallyJS
      throw new Error(`Nominatim answered ${res.status}`);
    }
    return parseNominatim(await res.json());
  } catch (err) {
    console.warn('[map-places] address search failed', err);
    throw new ConflictError('Address search isn’t working right now. Drop the pin on the map instead.');
  }
}
