import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/server/auth/session';
import { getAccessSettings } from '@/server/services/accessService';
import { listContactMessages } from '@/server/services/contactService';
import { isServerAdmin, listHouseholds } from '@/server/services/serverAdminService';
import { AccessCard } from '@/components/settings/access-settings';
import { ContactMessagesCard } from '@/components/settings/contact-messages-card';
import { HouseholdsCard } from '@/components/server/households-card';

// The server admin's page: households on this server and the settings that
// apply to all of them. The layout sends everyone else away, but a layout
// doesn't stop its page rendering, so the page checks too (and the services
// it calls check again).
export default async function ServerPage() {
  const session = await getServerSession();
  if (!session?.user) redirect('/login');
  const user = session.user;
  if (!(await isServerAdmin(user.id))) redirect('/dashboard');

  const [households, access, messages] = await Promise.all([
    listHouseholds(user.id),
    getAccessSettings(await headers()),
    listContactMessages(user.id),
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
