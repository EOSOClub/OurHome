import { fail, ok } from '@/server/api/http';
import { prisma } from '@/server/db/prisma';
import {
  extractIntegrationToken,
  resolveHouseholdByToken,
} from '@/server/services/integrationService';

// Read-only inventory feed for Home Assistant to *display* (REST sensors on a
// dashboard). Scanning and updates now happen in the Android app; HA just
// shows the numbers. Authenticated with the same integration token as the
// webhook (Settings → Home Assistant), not a session cookie.
export async function GET(req: Request): Promise<Response> {
  const token = extractIntegrationToken(req);
  if (!token) return fail('Missing token', 401);
  const resolved = await resolveHouseholdByToken(token);
  if (!resolved) return fail('Invalid token', 401);

  const items = await prisma.inventoryItem.findMany({
    where: { householdId: resolved.householdId },
    select: { id: true, name: true, unit: true, quantity: true, lowThreshold: true, isLow: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });

  return ok({
    count: items.length,
    lowCount: items.filter((i) => i.isLow).length,
    // Keyed by a slug of the name so HA templates can do value_json.data.items_by_slug.paper_towels.
    items_by_slug: Object.fromEntries(items.map((i) => [slug(i.name), toFeed(i)])),
    items: items.map(toFeed),
  });
}

function toFeed(i: {
  id: string;
  name: string;
  unit: string | null;
  quantity: number;
  lowThreshold: number;
  isLow: boolean;
  updatedAt: Date;
}) {
  return {
    id: i.id,
    name: i.name,
    unit: i.unit,
    quantity: i.quantity,
    low_threshold: i.lowThreshold,
    is_low: i.isLow,
    updated_at: i.updatedAt.toISOString(),
  };
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'item';
}
