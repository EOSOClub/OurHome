import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { APP_NAME } from '@/server/config';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Centralized household operations: chores, tasks, shopping & more.',
};

// The app is dark by default: `<html>` ships with the `dark` class already on
// it (below), so the correct theme is painted immediately — even if this script
// is delayed or blocked. The only job here is to step DOWN to light before the
// first paint when the user has explicitly chosen it, avoiding a dark flash.
const themeInitScript = `
(function () {
  try {
    if (localStorage.getItem('theme') === 'light') {
      document.documentElement.classList.remove('dark');
    }
  } catch (e) {}
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Nonce from the CSP set in src/proxy.ts, so this inline script is allowed.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
