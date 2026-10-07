import { headers } from 'next/headers';
import { requireUser } from '@/server/auth/session';
import { getAccessSettings } from '@/server/services/accessService';
import { can } from '@/lib/permissions';
import {
  itemToDTO,
  listInventoryItems,
} from '@/server/services/inventoryService';
import { listNfcTags } from '@/server/services/nfcService';
import { listIntegrations } from '@/server/services/integrationService';
import { listCategories } from '@/server/services/categoryService';
import { listContactMessages } from '@/server/services/contactService';
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
  const [integrations, tags, items, categories, contactMessages, access] =
    await Promise.all([
      listIntegrations(householdId),
      listNfcTags(householdId),
      listInventoryItems(householdId),
      listCategories(householdId),
      // Not household-scoped; gated by the settings:manage check above.
      listContactMessages(),
      // Security is the Head of House's alone (household:manage).
      can(user.role, 'household:manage')
        ? getAccessSettings(householdId, await headers())
        : null,
    ]);

  return (
    <SettingsView
      initialAccess={access}
      initialIntegrations={integrations}
      initialTags={tags}
      initialCategories={categories}
      initialContactMessages={contactMessages}
      items={items.map(itemToDTO).map((i) => ({ id: i.id, name: i.name }))}
    />
  );
}
