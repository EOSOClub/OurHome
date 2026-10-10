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
  const [integrations, tags, items, categories, points] =
    await Promise.all([
      listIntegrations(householdId),
      listNfcTags(householdId),
      listInventoryItems(householdId),
      listCategories(householdId),
      // Points rate / time zone / week start: the head's.
      isHead ? getPointsSettings(householdId) : null,
    ]);

  return (
    <SettingsView
      initialIntegrations={integrations}
      initialTags={tags}
      initialCategories={categories}
      initialPoints={points}
      canExport={isHead}
      items={items.map(itemToDTO).map((i) => ({ id: i.id, name: i.name }))}
    />
  );
}
