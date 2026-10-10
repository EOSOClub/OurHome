import { headers } from 'next/headers';
import { getServerSession } from '@/server/auth/session';
import { getAccessSettings } from '@/server/services/accessService';
import { listContactMessages } from '@/server/services/contactService';
import { listHouseholds } from '@/server/services/serverAdminService';
import { AccessCard } from '@/components/settings/access-settings';
import { ContactMessagesCard } from '@/components/settings/contact-messages-card';
import { HouseholdsCard } from '@/components/server/households-card';

// The server admin's page: households on this server and the settings that
// apply to all of them. The layout lets only the server admin in.
export default async function ServerPage() {
  const session = await getServerSession();
  const user = session!.user;

  const [households, access, messages] = await Promise.all([
    listHouseholds(user.id),
    getAccessSettings(await headers()),
    listContactMessages(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Server</h1>
        <p className="text-sm text-muted-foreground">
          Households on this server, and the settings that apply to all of them.
        </p>
      </div>
      <HouseholdsCard initial={households} />
      <AccessCard initialSettings={access} />
      <ContactMessagesCard initialMessages={messages} />
    </div>
  );
}
