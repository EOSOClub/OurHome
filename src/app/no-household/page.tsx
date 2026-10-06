import { SignOutButton } from '@/components/sign-out-button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function NoHouseholdPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>No household yet</CardTitle>
          <CardDescription>
            Your account isn’t linked to a household. Ask an admin to add you, or
            run the seed script to set one up.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton />
        </CardContent>
      </Card>
    </main>
  );
}
