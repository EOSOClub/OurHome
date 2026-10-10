'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { formatRelativeTime } from '@/lib/format';

// Pages are rendered on the server (UTC) and then hydrated in the browser
// (the viewer's zone). Any date label computed from "now" or a local day then
// came out differently in the two renders — e.g. "Due tomorrow" flipping to
// "Due today" in the evening. Formatting every date in the household's zone
// (Settings → Task points) makes both renders produce the same text.

const HouseholdZoneContext = createContext<string | undefined>(undefined);

export function HouseholdZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: React.ReactNode;
}) {
  return <HouseholdZoneContext.Provider value={timeZone}>{children}</HouseholdZoneContext.Provider>;
}

/** The household's IANA zone, for date formatting in client components. */
export function useHouseholdZone(): string | undefined {
  return useContext(HouseholdZoneContext);
}

/**
 * "5m ago", kept current. The server's text is kept as rendered (it may be a
 * minute older than the browser's clock), then the label refreshes every
 * minute after mount, so it never mismatches or goes stale.
 */
export function RelativeTime({ date, title }: { date: Date | string; title?: string }) {
  const timeZone = useHouseholdZone();
  const [, setTick] = useState(0);
  useEffect(() => {
    const tick = () => setTick((t) => t + 1);
    // Right after hydration (catch up with the browser's clock), then every minute.
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  return (
    <time dateTime={new Date(date).toISOString()} title={title} suppressHydrationWarning>
      {formatRelativeTime(date, timeZone)}
    </time>
  );
}
