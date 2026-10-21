import { requireUser } from '@/server/auth/session';
import { can } from '@/lib/permissions';
import {
  itemToDTO,
  listInventoryItems,
} from '@/server/services/inventoryService';
import { listNfcTags } from '@/server/services/nfcService';
import { listIntegrations } from '@/server/services/integrationService';
import { listCategories } from '@/server/services/categoryService';
import { getPointsSettings } from '@/server/services/pointsService';
import { listPlaces } from '@/server/services/placeService';
import { listMapPlaces } from '@/server/services/mapPlaceService';
import { getLiveCheckSettings } from '@/server/services/liveCheckService';
import { listShoppingLists } from '@/server/services/shoppingService';
import { getRequestModules } from '@/server/services/requestModuleService';
import { prisma } from '@/server/db/prisma';
import { SettingsView } from '@/components/settings/settings-view';

export default async function SettingsPage() {
  const user = await requireUser();

  if (!can(user.role, 'settings:manage')) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Home Assistant and NFC settings are managed by the Head of House or a
          Manager.
        </p>
      </div>
    );
  }

  const householdId = user.householdId!;
  const isHead = can(user.role, 'household:manage');
  // "HTTPS only" and contact-form messages are server-wide: they're on the
  // server admin's Server page now.
  const [
    integrations,
    tags,
    items,
    categories,
    points,
    liveChecks,
    places,
    mapPlaces,
    shoppingLists,
    requestModules,
    members,
  ] = await Promise.all([
      listIntegrations(householdId),
      listNfcTags(householdId),
      listInventoryItems(householdId),
      listCategories(householdId),
      // Points rate / time zone / week start: the head's.
      isHead ? getPointsSettings(householdId) : null,
      // Live location check limits: the head's too.
      isHead ? getLiveCheckSettings(householdId) : null,
      listPlaces(householdId),
      listMapPlaces(householdId),
      // Stores on the map remind about these.
      listShoppingLists(householdId),
      // Request types and the people they name: the head's.
      isHead ? getRequestModules(householdId) : null,
      isHead
        ? prisma.user.findMany({ where: { householdId }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
        : [],
    ]);

  return (
    <SettingsView
      initialIntegrations={integrations}
      initialTags={tags}
      initialCategories={categories}
      initialPoints={points}
      initialLiveChecks={liveChecks}
      initialRequestModules={requestModules}
      members={members}
      initialPlaces={places}
      initialMapPlaces={mapPlaces}
      shoppingLists={shoppingLists.map((l) => ({ id: l.id, name: l.name }))}
      canExport={isHead}
      items={items.map(itemToDTO).map((i) => ({ id: i.id, name: i.name }))}
    />
  );
}
