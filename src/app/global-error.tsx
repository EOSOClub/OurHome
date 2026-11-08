'use client';

import { useEffect } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import './globals.css';

/**
 * Last-resort error page, for a failure in the root layout itself. It replaces
 * that layout, so it renders its own <html> and <body>, imports the global
 * styles, and applies the saved theme: the root layout's theme script doesn't
 * run here.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  useEffect(() => {
    // Dark by default, as in the root layout; step down to light if chosen.
    try {
      if (localStorage.getItem('theme') === 'light') {
        document.documentElement.classList.remove('dark');
      }
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);

  return (
    <html lang="en" className="h-full dark" suppressHydrationWarning>
      <body
        className="flex min-h-full flex-col"
        // The root layout's font isn't loaded here; use the system font.
        style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}
      >
        <title>Something went wrong</title>
        <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
          <h1 className="text-2xl font-semibold">Something went wrong</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            This page couldn&apos;t be shown. Try again, and if it keeps happening, go back to the
            home page.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={() => retry()}>
              Try again
            </Button>
            {/* A full page load: the app around this page failed, so start it fresh. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className={buttonVariants({ variant: 'outline' })}>
              Go to Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
