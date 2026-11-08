import Link from 'next/link';
import { MapPinOff } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';

/**
 * Shown for a link that leads nowhere (an unknown address, or a page that
 * calls notFound()). Rendered inside the root layout, so the app's styles and
 * theme apply.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <MapPinOff className="size-6" aria-hidden />
      </span>
      <h1 className="text-2xl font-semibold">We couldn&apos;t find that page</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The link may be old, or the page may have been moved or removed.
      </p>
      <Link href="/" className={buttonVariants()}>
        Go to Home
      </Link>
    </main>
  );
}
