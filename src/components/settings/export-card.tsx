import { Download } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** Head of House: download everything the household has stored, as JSON. */
export function ExportCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="size-4" /> Export household data
        </CardTitle>
        <CardDescription>
          A copy of everything your household has stored here — members, tasks and points, bills,
          shopping, stock, requests, calendar and activity — as one JSON file. Passwords and
          connection tokens are never included.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a href="/api/household/export" download className={buttonVariants({ variant: 'outline' })}>
          <Download /> Download export
        </a>
      </CardContent>
    </Card>
  );
}
