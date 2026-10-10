import { SignOutButton } from '@/components/sign-out-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { HOUSEHOLD_DISABLED_MESSAGE } from '@/server/services/serverAdminService';

export default async function NoHouseholdPage({
  searchParams,
}: {
  searchParams: Promise<{ disabled?: string }>;
}) {
  // ?disabled=1: the server admin turned this household off.
  const { disabled } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{disabled ? 'Household turned off' : 'No household yet'}</CardTitle>
          <CardDescription>
            {disabled
              ? HOUSEHOLD_DISABLED_MESSAGE
              : 'Your account isn’t linked to a household. Ask your Head of House to add you from the Members page.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton />
        </CardContent>
      </Card>
    </main>
  );
}
