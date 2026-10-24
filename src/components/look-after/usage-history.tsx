'use client';

import { useState, type ReactNode } from 'react';
import type { UsageAppDTO, UsageHistoryDTO } from '@/lib/types';
import {
  USAGE_CHART_DAYS,
  USAGE_TOP_APPS,
  averageMinutes,
  chartDays,
  formatMinutes,
  usageDayLabel,
  usageIconUrl,
  weekdayLabel,
} from '@/lib/appUsage';
import { cn } from '@/lib/utils';

// Someone's app usage over the last week: a bar per day (tap one to pick it),
// then every app kept for the picked day. Shown to a supervisor on "People
// you look after" and to the child on their own Profile (the app has the same).

/** Height of the tallest bar, in pixels. */
const BAR_PX = 96;

/** The app's icon from their phone, or its first letter until the phone has sent it. */
export function AppIcon({ app }: { app: UsageAppDTO }) {
  const [broken, setBroken] = useState(false);
  if (app.icon && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small private PNG from our own API, no optimising to do
      <img src={usageIconUrl(app.app)} alt="" className="size-5 shrink-0 rounded" onError={() => setBroken(true)} />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
    >
      {app.label.slice(0, 1)}
    </span>
  );
}

/** What goes at the end of an app's row (a supervisor's Block), if anything. */
export type AppAction = (app: UsageAppDTO) => ReactNode;

/** Apps as rows: icon, name, time, then [action]'s part. */
export function AppList({ apps, action }: { apps: UsageAppDTO[]; action?: AppAction }) {
  return (
    <ul className="space-y-1">
      {apps.map((a) => (
        <li key={a.app} className={cn('flex items-center gap-2 text-xs', action && 'min-h-6')}>
          <AppIcon app={a} />
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatMinutes(a.minutes)}</span>
          {action ? action(a) : null}
        </li>
      ))}
    </ul>
  );
}

export function UsageHistory({ history, appAction }: { history: UsageHistoryDTO; appAction?: AppAction }) {
  const [picked, setPicked] = useState<string | null>(null);
  // en-CA writes the viewer's local date as YYYY-MM-DD, like the phone's day.
  const today = new Date().toLocaleDateString('en-CA');
  // The newest day until another is picked (or when the picked one has aged out).
  const shown = history.days.find((d) => d.day === picked) ?? history.days[0];
  if (!shown) {
    return <p className="text-xs text-muted-foreground">No app usage from the phone yet.</p>;
  }
  const chart = chartDays(history.days, today);
  const tallest = Math.max(60, ...chart.map((c) => c.minutes ?? 0));
  const average = averageMinutes(chart);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Last {USAGE_CHART_DAYS} days
          {average !== null ? (
            <>
              {' · '}about <span className="font-medium text-foreground">{formatMinutes(average)}</span> a day
            </>
          ) : null}
        </p>
        <div className="flex gap-1.5" role="group" aria-label={`Time in apps each day, last ${USAGE_CHART_DAYS} days`}>
          {chart.map((c) => {
            const selected = c.day === shown.day;
            const label = `${usageDayLabel(c.day, today)}: ${
              c.minutes === null ? 'nothing from the phone' : formatMinutes(c.minutes)
            }`;
            return (
              <button
                key={c.day}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected}
                disabled={c.minutes === null}
                onClick={() => setPicked(c.day)}
                className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md py-1 hover:bg-accent disabled:hover:bg-transparent"
              >
                <span className="flex w-full items-end justify-center" style={{ height: BAR_PX }}>
                  <span
                    className={cn(
                      'w-full max-w-8 rounded-t',
                      c.minutes === null ? 'bg-border' : selected ? 'bg-primary' : 'bg-primary/35',
                    )}
                    style={{ height: c.minutes ? Math.max(3, Math.round((c.minutes / tallest) * BAR_PX)) : 2 }}
                  />
                </span>
                <span
                  className={cn('text-[11px]', selected ? 'font-semibold text-foreground' : 'text-muted-foreground')}
                >
                  {weekdayLabel(c.day)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">
          {usageDayLabel(shown.day, today)}: {formatMinutes(shown.totalMinutes)}
        </p>
        {shown.apps.length > 0 ? (
          <AppList apps={shown.apps} action={appAction} />
        ) : (
          <p className="text-xs text-muted-foreground">No app was open for a full minute.</p>
        )}
        {shown.apps.length >= USAGE_TOP_APPS ? (
          <p className="text-xs text-muted-foreground">Only the {USAGE_TOP_APPS} most used apps are kept for each day.</p>
        ) : null}
      </div>
    </div>
  );
}
