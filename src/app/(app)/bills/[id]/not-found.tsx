import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

// Rendered when the detail page calls notFound() — e.g. a deleted bill or a
// stale link from another household.
export default function BillNotFound() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-4 py-12 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Receipt className="size-5" />
        </span>
        <div>
          <p className="font-medium">Bill not found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been deleted, or the link is out of date.
          </p>
        </div>
        <Link href="/bills" className={buttonVariants({ variant: 'outline' })}>
          Back to bills
        </Link>
      </CardContent>
    </Card>
  );
}
