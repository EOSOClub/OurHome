'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, ChevronLeft, ChevronRight, HeartHandshake, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  AppLimitDTO,
  BlockedAppDTO,
  LookAfterDTO,
  RingDTO,
  ScheduleDTO,
  UsageAppDTO,
  UsageHistoryDTO,
} from '@/lib/types';
import { apiFetch, ApiError, fieldErrors } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { LIVE_CHECKS_KEY } from '@/components/profile/location-card';
import { RelativeTime } from '@/components/household-zone';
import {
  PHONE_PROBLEM_LABELS,
  PHONE_RULES,
  PHONE_RULE_LABELS,
  SILENT_PROBLEMS,
  type PhoneRule,
} from '@/lib/phoneHealth';
import { formatMinutes, usageDayLabel } from '@/lib/appUsage';
import { ALL_APPS, ALL_APPS_LABEL, limitLabel, limitOptions, limitsSummary } from '@/lib/appLimits';
import { CAP_CHOICES, GIVE_STEPS, RATE_CHOICES } from '@/lib/pointsTime';
import { formatPoints } from '@/lib/taskPoints';
import {
  EVERY_DAY,
  MAX_ALLOWED,
  MAX_SCHEDULES,
  SCHEDULE_DAYS,
  SCHEDULE_PRESETS,
  WEEKDAYS,
  clockValue,
  daysLabel,
  parseClock,
  scheduleTimes,
  schedulesSummary,
} from '@/lib/appSchedules';
import { RING_MS, ringActive, ringOutcome } from '@/lib/ring';
import { SetupProgress, setupSummary } from '@/components/look-after/setup-progress';
import { AppIcon, AppList, UsageHistory, type AppAction } from '@/components/look-after/usage-history';

// The "People you look after" page: the children and teens the viewer
// supervises (the Head's supervision list). First a summary card for each
// (with Ring); a card opens that person's page (?person=<id>), where the
// viewer can ring their phone, make their
// location sharing required, share their app usage, block apps from it, give
// apps a daily limit, set schedules and let them buy time with points,
// choose which protections their phone must have on (PHONE_RULES). Only
// linked for adults who supervise someone; the server checks it again.

export const LOOK_AFTER_KEY = ['look-after'];

/** A child's usage history, opened under their latest day (keyed by their id after this). */
const USAGE_HISTORY_KEY = ['usage-history'];

/** Refetched this often while open, so check-ins and usage stay current (the app does the same). */
const REFETCH_MS = 60_000;

/** While a ring of the viewer's is going, so its "ringing" and "Stop was tapped" show in seconds. */
const RING_REFETCH_MS = 3_000;

const ringGoing = (data: LookAfterDTO | undefined) =>
  !!data?.people.some((p) => p.ring && ringActive(p.ring.phase));

/** After asking the phones for fresh usage, look again this long after (they answer in seconds). */
const AFTER_REFRESH_MS = [10_000, 25_000];

export function LookAfterView({ initial }: { initial: LookAfterDTO }) {
  const queryClient = useQueryClient();
  const { data = initial } = useQuery({
    queryKey: LOOK_AFTER_KEY,
    queryFn: () => apiFetch<LookAfterDTO>('/api/supervision/mine'),
    initialData: initial,
    refetchInterval: (query) => (ringGoing(query.state.data) ? RING_REFETCH_MS : REFETCH_MS),
  });

  // Opening the page asks each child's phone whose usage is shared to send it
  // now (a push; the server skips it when it can't or just did). Best effort:
  // the page shows what's stored either way. Once per visit: the ref survives
  // React running the effect twice in development, and the later refetches
  // are harmless after leaving (the query is only marked stale).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const ids = initial.people.filter((p) => p.appUsage.shared).map((p) => p.id);
    if (ids.length === 0) return;
    Promise.all(
      ids.map((supervisedId) =>
        apiFetch<{ asked: boolean }>('/api/supervision/usage/refresh', {
          method: 'POST',
          body: JSON.stringify({ supervisedId }),
        }).catch(() => ({ asked: false })),
      ),
    ).then((answers) => {
      if (!answers.some((a) => a.asked)) return;
      for (const ms of AFTER_REFRESH_MS) {
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: LOOK_AFTER_KEY });
          queryClient.invalidateQueries({ queryKey: USAGE_HISTORY_KEY });
        }, ms);
      }
    });
  }, [initial, queryClient]);

  // Ring buttons rest while a ring of the viewer's goes (see RingButton), kept
  // here so moving between the cards and a person's page doesn't free them.
  const [ringingUntil, setRingingUntil] = useState<Record<string, number>>({});
  const ringProps = (person: Person) => ({
    person,
    until: ringingUntil[person.id] ?? 0,
    onRang: (until: number) => setRingingUntil((r) => ({ ...r, [person.id]: until })),
  });

  // One person's page is the same page with ?person=<id>, so Back returns to the cards.
  const selectedId = useSearchParams().get('person');
  const selected = data.people.find((p) => p.id === selectedId);

  if (selected) {
    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/look-after"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="size-4" /> People you look after
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <HeartHandshake className="size-6" /> {selected.name}
          </h1>
        </div>
        <Card className="max-w-2xl">
          <CardContent className="space-y-3 pt-5">
            <PersonDetail {...ringProps(selected)} canRing={data.canRing} />
            <p className="text-xs text-muted-foreground">
              <strong>Ring</strong> rings their phone loudly for up to 30 seconds, even on silent. You see when it
              starts ringing, and whether someone tapped Stop.{' '}
              <strong>Location required</strong> keeps their location sharing on, and lets you check where they are
              on the Map without them allowing it. They always see when you check. <strong>Share app usage</strong>{' '}
              shows you how long they spend in each app; their phone needs Usage access for it. Their phone sends it
              every 15 minutes, and opening this page asks it for the latest numbers. They see the same numbers on their
              Profile. While it&apos;s shared, you&apos;re also told when a new app turns up on their phone.{' '}
              <strong>Block</strong> next to an app stops it opening on their phone: they see a screen saying you
              blocked it. Blocking needs Keep Our Home running on their phone. Phone calls, messages and OurHome
              always stay open.{' '}
              <strong>Daily limits</strong> give all their apps together, or one app, so much time a day. Their phone
              warns them 5 minutes before, then closes the app until midnight, and you&apos;re told. Limits need Usage
              access and Keep Our Home running on their phone.{' '}
              <strong>Schedules</strong> close all their apps at set times, like bedtime or school, apart from calls,
              messages and any apps you leave open. Their phone warns them 5 minutes before. Schedules need Keep Our
              Home running on their phone.{' '}
              <strong>Points for screen time</strong> lets them spend task points on more time on today&apos;s
              limits, at the rate you set and up to a daily most; you&apos;re told each time. Their earned points
              in the stats don&apos;t change. <strong>Give extra time</strong> adds minutes to today&apos;s limits
              without points.{' '}
              <strong>Require Keep Our Home running</strong> stops OurHome being closed on their phone.{' '}
              <strong>Require Prevent uninstall</strong> stops it being removed without your PIN.{' '}
              <strong>Require Unrestricted battery</strong> stops battery saving from holding back rings and alerts.
              Each one you require is a step in Set up this phone in the app on their phone, and you&apos;re told if
              it gets turned off. Not requiring one only stops the step and the alert: whatever is already on stays
              on.
              {data.canRing
                ? null
                : ' Ringing needs instant phone alerts: Firebase on this server, or Stay connected turned on in the app on their phone.'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <HeartHandshake className="size-6" /> People you look after
        </h1>
        <p className="text-sm text-muted-foreground">
          The children and teens the Head of House asked you to supervise. Tap someone to see and change
          everything for them. Everything you do here is logged in Activity.
        </p>
      </div>

      {data.people.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          You don&apos;t look after anyone right now. The Head of House chooses who supervises whom on the Members
          page.
        </p>
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.people.map((person) => (
              <PersonCard key={person.id} {...ringProps(person)} canRing={data.canRing} />
            ))}
          </ul>
          {data.canRing ? null : (
            <p className="text-xs text-muted-foreground">
              Ringing needs instant phone alerts: Firebase on this server, or Stay connected turned on in the app on
              their phone.
            </p>
          )}
        </>
      )}
    </div>
  );
}

type Person = LookAfterDTO['people'][number];

/** Their location sharing, in a line. */
const SHARING_SUMMARY: Record<Person['sharing'], string> = {
  required: 'Location required',
  on: 'Shares their location',
  off: 'Not sharing their location',
};

/**
 * One person on the first page: what needs seeing at a glance (their phone,
 * location, today's app time, setup, the last ring), and Ring. The card opens
 * their page, where everything can be changed.
 */
function PersonCard({ person, canRing, until, onRang }: RingButtonProps & { canRing: boolean }) {
  const latest = person.appUsage.latest;
  return (
    <li>
      <Card
        className={cn(
          'flex h-full flex-col overflow-hidden',
          person.phone?.problems.length ? 'border-destructive/60' : undefined,
        )}
      >
        <Link
          href={`/look-after?person=${encodeURIComponent(person.id)}`}
          className="block flex-1 space-y-1 p-4 transition-colors hover:bg-muted/40"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">{person.name}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </span>
          <PhoneStatus phone={person.phone} />
          <span className="block text-xs text-muted-foreground">{SHARING_SUMMARY[person.sharing]}</span>
          <span className="block text-xs text-muted-foreground">
            {!person.appUsage.shared
              ? 'App usage not shared'
              : latest
                ? `${usageDayLabel(latest.day, new Date().toLocaleDateString('en-CA'))}: ${formatMinutes(latest.totalMinutes)} in apps`
                : 'No app usage from their phone yet'}
          </span>
          {person.blocking.apps.length > 0 ? (
            <span className="block text-xs text-muted-foreground">{blockedSummary(person.blocking.apps)}</span>
          ) : null}
          {limitsLine(person) ? <span className="block text-xs text-muted-foreground">{limitsLine(person)}</span> : null}
          {person.schedules.length > 0 ? (
            <span className="block text-xs text-muted-foreground">{schedulesSummary(person.schedules)}</span>
          ) : null}
          <span className="block text-xs text-muted-foreground">{setupSummary(person)}</span>
          {person.ring ? <RingLine ring={person.ring} /> : null}
        </Link>
        {canRing ? (
          <div className="flex justify-end border-t border-border px-4 py-2">
            <RingButton person={person} until={until} onRang={onRang} />
          </div>
        ) : null}
      </Card>
    </li>
  );
}

/**
 * Their phone: what's wrong with it (red), or when it last checked in; then
 * how instant alerts reach it (Stay connected, or when the last one arrived).
 */
function PhoneLine({ phone }: { phone: LookAfterDTO['people'][number]['phone'] }) {
  return (
    <>
      <PhoneStatus phone={phone} />
      {phone ? <AlertsLine phone={phone} /> : null}
    </>
  );
}

/** What's wrong with their phone (red), or when it last checked in. */
function PhoneStatus({ phone }: { phone: LookAfterDTO['people'][number]['phone'] }) {
  if (!phone) {
    return <span className="block text-xs text-muted-foreground">Their phone hasn&apos;t checked in yet</span>;
  }
  return (
    <>
      {phone.problems.length > 0 ? (
        <span className="block text-xs font-medium text-destructive">
          {phone.problems.map((p) => PHONE_PROBLEM_LABELS[p]).join(' · ')}
          {phone.problems.some((p) => SILENT_PROBLEMS.has(p)) ? (
            <>
              {' '}
              (last seen <RelativeTime date={phone.lastSeenAt} />)
            </>
          ) : null}
        </span>
      ) : (
        <span className="block text-xs text-muted-foreground">
          Phone checked in <RelativeTime date={phone.lastSeenAt} />
        </span>
      )}
    </>
  );
}

/** How instant alerts reach their phone; nothing for an app too old to say. */
function AlertsLine({ phone }: { phone: NonNullable<LookAfterDTO['people'][number]['phone']> }) {
  if (phone.stayConnected) {
    return (
      <span className="block text-xs text-muted-foreground">
        {phone.connected ? 'Stay connected: connected now' : 'Stay connected is on, but it isn’t connected right now'}
      </span>
    );
  }
  if (!phone.lastPushAt) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      Last instant alert reached it <RelativeTime date={phone.lastPushAt} />
    </span>
  );
}

/** The viewer's last ring of their phone and what the phone said back. */
function RingLine({ ring }: { ring: RingDTO }) {
  return (
    <span
      className={`block text-xs ${ring.phase === 'no_answer' ? 'text-destructive' : 'text-muted-foreground'}`}
      aria-live="polite"
    >
      You rang <RelativeTime date={ring.sentAt} />: {ringOutcome(ring)}
    </span>
  );
}

/**
 * The latest day their phone reported: total, then the top apps with their
 * icons; then, on request, the week's chart and every app.
 */
function UsageLine({ person }: { person: Person }) {
  const [open, setOpen] = useState(false);
  const latest = person.appUsage.latest;
  const action: AppAction = (app) => <BlockButton person={person} app={app} />;
  if (!latest) {
    return (
      <p className="text-xs text-muted-foreground">
        No app usage from their phone yet. It needs the latest OurHome app, and Usage access allowed.
      </p>
    );
  }
  // en-CA writes the viewer's local date as YYYY-MM-DD, like the phone's day.
  const dayLabel = usageDayLabel(latest.day, new Date().toLocaleDateString('en-CA'));
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {dayLabel}: {formatMinutes(latest.totalMinutes)}
        </span>
        {' · '}updated <RelativeTime date={latest.updatedAt} />
      </p>
      {open ? (
        <UsageHistoryPanel personId={person.id} action={action} />
      ) : latest.top.length > 0 ? (
        <AppList apps={latest.top} action={action} />
      ) : null}
      <Button
        size="sm"
        variant="link"
        className="h-auto px-0 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? 'Show less' : 'All apps and the last 7 days'}
      </Button>
    </div>
  );
}

/** Their week's chart and every app, loaded when opened and kept current while open. */
function UsageHistoryPanel({ personId, action }: { personId: string; action: AppAction }) {
  const { data, isPending, isError } = useQuery({
    queryKey: [...USAGE_HISTORY_KEY, personId],
    queryFn: () =>
      apiFetch<UsageHistoryDTO>(`/api/supervision/usage/history?supervisedId=${encodeURIComponent(personId)}`),
    refetchInterval: REFETCH_MS,
  });
  if (isPending) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (isError) return <p className="text-xs text-destructive">Couldn&apos;t load their app usage.</p>;
  return <UsageHistory history={data} appAction={action} />;
}

/** "Roblox blocked", "Roblox and TikTok blocked", "3 apps blocked". */
function blockedSummary(apps: BlockedAppDTO[]): string {
  if (apps.length === 1) return `${apps[0].label} blocked`;
  if (apps.length === 2) return `${apps[0].label} and ${apps[1].label} blocked`;
  return `${apps.length} apps blocked`;
}

/** Blocks or unblocks one app on their phone; the answer is the page's new data. */
function useBlockApp(person: Person) {
  const queryClient = useQueryClient();
  return useMutation({
    // A refetch already on its way mustn't put the old list back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: ({ app, blocked }: { app: string; label: string; blocked: boolean }) =>
      apiFetch<LookAfterDTO>('/api/supervision/blocked-apps', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, app, blocked }),
      }),
    onSuccess: (next, { label, blocked }) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(
        blocked ? `${label} is blocked on ${person.name}’s phone` : `${label} is unblocked on ${person.name}’s phone`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
}

/** The end of an app's row in their usage: Block, or Unblock (red) once blocked; "Always open" for an app their phone never blocks. */
function BlockButton({ person, app }: { person: Person; app: UsageAppDTO }) {
  const block = useBlockApp(person);
  if (person.blocking.alwaysAllowed.includes(app.app)) {
    return <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">Always open</span>;
  }
  const isBlocked = block.isPending
    ? block.variables.blocked
    : person.blocking.apps.some((b) => b.app === app.app);
  return (
    <span className="flex w-16 shrink-0 justify-end">
      {isBlocked ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px] text-destructive hover:text-destructive"
          disabled={block.isPending}
          aria-label={`Unblock ${app.label}`}
          onClick={() => block.mutate({ app: app.app, label: app.label, blocked: false })}
        >
          Unblock
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          disabled={block.isPending}
          aria-label={`Block ${app.label}`}
          onClick={() => block.mutate({ app: app.app, label: app.label, blocked: true })}
        >
          Block
        </Button>
      )}
    </span>
  );
}

/** The apps blocked on their phone, who blocked each and when, with Unblock. */
function BlockedApps({ person }: { person: Person }) {
  const { apps, works } = person.blocking;
  if (apps.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Blocked apps</p>
      {works === false ? (
        <p className="text-xs text-destructive">
          Keep Our Home running is off on their phone, so these apps open anyway until it&apos;s back on.
        </p>
      ) : null}
      <ul className="space-y-1">
        {apps.map((a) => (
          <BlockedRow key={a.app} person={person} app={a} />
        ))}
      </ul>
    </div>
  );
}

function BlockedRow({ person, app }: { person: Person; app: BlockedAppDTO }) {
  const block = useBlockApp(person);
  return (
    <li className="flex min-h-7 items-center gap-2 text-xs">
      <AppIcon app={{ app: app.app, label: app.label, icon: app.icon, minutes: 0 }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{app.label}</span>
        <span className="block text-[11px] text-muted-foreground">
          Blocked by {app.byName} <RelativeTime date={app.at} />
        </span>
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-2 text-xs"
        disabled={block.isPending}
        onClick={() => block.mutate({ app: app.app, label: app.label, blocked: false })}
      >
        {block.isPending ? <Loader2 className="animate-spin" /> : null}
        Unblock
      </Button>
    </li>
  );
}

/** The card's line about their daily limits, or null when there are none. */
function limitsLine(person: Person): string | null {
  return limitsSummary(person.limits.total?.minutes ?? null, person.limits.apps);
}

/** Sets, changes or removes (minutes null) one daily limit on their phone; the answer is the page's new data. */
function useAppLimit(person: Person) {
  const queryClient = useQueryClient();
  return useMutation({
    // A refetch already on its way mustn't put the old limits back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: ({ app, minutes }: { app: string; label: string; minutes: number | null }) =>
      apiFetch<LookAfterDTO>('/api/supervision/app-limits', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, app, minutes }),
      }),
    onSuccess: (next, { label, minutes }) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(
        minutes === null
          ? `${label}: no limit on ${person.name}’s phone`
          : `${label}: ${limitLabel(minutes)} on ${person.name}’s phone`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
}

/** A limit's minutes as a dropdown; [none] adds a "No limit" choice (minutes null). */
function LimitSelect({
  value,
  onChange,
  none,
  disabled,
  label,
}: {
  value: number | null;
  onChange: (minutes: number | null) => void;
  none?: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      className="h-8 w-auto shrink-0 px-2 py-0 text-xs"
      value={value === null ? '' : String(value)}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      {none ? <option value="">No limit</option> : null}
      {limitOptions(value).map((m) => (
        <option key={m} value={m}>
          {limitLabel(m)}
        </option>
      ))}
    </Select>
  );
}

/**
 * Their daily limits: all apps together, then each app's own with who set it,
 * and adding one for an app from their usage. Shown while their usage is
 * shared, or while a limit is left from before.
 */
function DailyLimits({ person }: { person: Person }) {
  const { total, apps, counts } = person.limits;
  // Any app from their usage without a limit of its own yet.
  const choices = person.usageApps.filter((a) => !apps.some((l) => l.app === a.app));
  const save = useAppLimit(person);
  const [adding, setAdding] = useState('');
  const [addMinutes, setAddMinutes] = useState(60);
  if (!person.appUsage.shared && !total && apps.length === 0) return null;
  const pendingFor = (app: string) => save.isPending && save.variables.app === app;
  const totalValue = save.isPending && save.variables.app === ALL_APPS ? save.variables.minutes : (total?.minutes ?? null);
  const pick = choices.find((c) => c.app === adding);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Daily limits</p>
      {counts === false ? (
        <p className="text-xs text-destructive">
          Usage access is off on their phone, so it can&apos;t count their time until it&apos;s back on.
        </p>
      ) : null}
      {person.blocking.works === false && (total || apps.length > 0) ? (
        <p className="text-xs text-destructive">
          Keep Our Home running is off on their phone, so nothing closes when time runs out until it&apos;s back on.
        </p>
      ) : null}
      <ul className="space-y-1">
        <li className="flex min-h-8 items-center gap-2 text-xs">
          <span className="min-w-0 flex-1">
            <span className="block truncate">{ALL_APPS_LABEL}</span>
            <span className="block text-[11px] text-muted-foreground">
              {total ? (
                <>
                  Set by {total.byName} <RelativeTime date={total.at} />
                </>
              ) : (
                'Together, apart from calls and messages'
              )}
            </span>
          </span>
          <LimitSelect
            label="Daily limit for all apps"
            none
            value={totalValue}
            disabled={save.isPending}
            onChange={(minutes) => save.mutate({ app: ALL_APPS, label: ALL_APPS_LABEL, minutes })}
          />
        </li>
        {apps.map((a) => (
          <LimitRow key={a.app} limit={a} pending={pendingFor(a.app)} save={save} />
        ))}
      </ul>
      {choices.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Select
            aria-label="App to limit"
            className="h-8 min-w-0 flex-1 basis-48 px-2 py-0 text-xs"
            value={adding}
            disabled={save.isPending}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">Add a limit for an app…</option>
            {choices.map((c) => (
              <option key={c.app} value={c.app}>
                {c.label}
              </option>
            ))}
          </Select>
          {/* Together, so on a narrow screen they move under the app as one. */}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <LimitSelect
              label="Daily limit for the app"
              value={addMinutes}
              disabled={save.isPending}
              onChange={(minutes) => setAddMinutes(minutes ?? 60)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 px-3 text-xs"
              disabled={!pick || save.isPending}
              onClick={() =>
                pick &&
                save.mutate(
                  { app: pick.app, label: pick.label, minutes: addMinutes },
                  { onSuccess: () => setAdding('') },
                )
              }
            >
              {pendingFor(adding) ? <Loader2 className="animate-spin" /> : null}
              Add
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** One app's own limit: who set it, its minutes (changed at once), and Remove. */
function LimitRow({
  limit,
  pending,
  save,
}: {
  limit: AppLimitDTO;
  pending: boolean;
  save: ReturnType<typeof useAppLimit>;
}) {
  const value = pending && save.variables?.minutes != null ? save.variables.minutes : limit.minutes;
  return (
    <li className="flex min-h-8 items-center gap-2 text-xs">
      <AppIcon app={{ app: limit.app, label: limit.label, icon: limit.icon, minutes: 0 }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{limit.label}</span>
        <span className="block text-[11px] text-muted-foreground">
          Set by {limit.byName} <RelativeTime date={limit.at} />
        </span>
      </span>
      <LimitSelect
        label={`Daily limit for ${limit.label}`}
        value={value}
        disabled={save.isPending}
        onChange={(minutes) => save.mutate({ app: limit.app, label: limit.label, minutes })}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-8 shrink-0 px-2 text-xs"
        disabled={save.isPending}
        aria-label={`Remove the limit for ${limit.label}`}
        onClick={() => save.mutate({ app: limit.app, label: limit.label, minutes: null })}
      >
        {pending && save.variables?.minutes === null ? <Loader2 className="animate-spin" /> : null}
        Remove
      </Button>
    </li>
  );
}

/** Their schedules, each with Edit and Remove, and Add a schedule (one form open at a time). */
function Schedules({ person }: { person: Person }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const remove = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (schedule: ScheduleDTO) =>
      apiFetch<LookAfterDTO>('/api/supervision/schedules/remove', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, id: schedule.id }),
      }),
    onSuccess: (next, schedule) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(`${schedule.name} is off ${person.name}’s phone`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove it.'),
  });
  const list = person.schedules;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Schedules</p>
      {person.blocking.works === false && list.length > 0 ? (
        <p className="text-xs text-destructive">
          Keep Our Home running is off on their phone, so their apps stay open during these until it&apos;s back on.
        </p>
      ) : null}
      {list.length === 0 && editing !== 'new' ? (
        <p className="text-xs text-muted-foreground">
          Times when their apps close, like bedtime or school. Calls and messages always work.
        </p>
      ) : null}
      {list.length > 0 ? (
        <ul className="space-y-2">
          {list.map((s) =>
            editing === s.id ? (
              <li key={s.id}>
                <ScheduleForm person={person} schedule={s} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={s.id} className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{s.name}</span>
                  <span className="block text-muted-foreground">
                    {daysLabel(s.days)} · {scheduleTimes(s.start, s.end)}
                  </span>
                  {s.allowed.length > 0 ? (
                    <span className="block text-[11px] text-muted-foreground">
                      Still open: {s.allowed.map((a) => a.label).join(', ')}
                    </span>
                  ) : null}
                  <span className="block text-[11px] text-muted-foreground">
                    Set by {s.byName} <RelativeTime date={s.at} />
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={remove.isPending || editing !== null}
                  aria-label={`Edit ${s.name}`}
                  onClick={() => setEditing(s.id)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={remove.isPending || editing !== null}
                  aria-label={`Remove ${s.name}`}
                  onClick={() => remove.mutate(s)}
                >
                  {remove.isPending && remove.variables.id === s.id ? <Loader2 className="animate-spin" /> : null}
                  Remove
                </Button>
              </li>
            ),
          )}
        </ul>
      ) : null}
      {editing === 'new' ? (
        <ScheduleForm person={person} schedule={null} onDone={() => setEditing(null)} />
      ) : list.length < MAX_SCHEDULES ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={editing !== null}
          onClick={() => setEditing('new')}
        >
          Add a schedule
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A schedule's name, days, times and the apps still open meanwhile; a new one
 * starts as Bedtime, and the other presets fill it in with a tap.
 */
function ScheduleForm({
  person,
  schedule,
  onDone,
}: {
  person: Person;
  schedule: ScheduleDTO | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const first = schedule ?? SCHEDULE_PRESETS[0];
  const [name, setName] = useState(first.name);
  const [days, setDays] = useState<number[]>([...first.days]);
  const [start, setStart] = useState(clockValue(first.start));
  const [end, setEnd] = useState(clockValue(first.end));
  const [allowed, setAllowed] = useState<string[]>(schedule?.allowed.map((a) => a.app) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Apps already allowed that have left their usage still show, so they can be unticked.
  const apps = [
    ...person.usageApps,
    ...(schedule?.allowed ?? []).filter((a) => !person.usageApps.some((u) => u.app === a.app)),
  ];
  const save = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (body: { name: string; days: number[]; start: number; end: number; allowed: string[] }) =>
      apiFetch<LookAfterDTO>('/api/supervision/schedules', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, ...(schedule ? { id: schedule.id } : {}), ...body }),
      }),
    onSuccess: (next, body) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(`${body.name} is set on ${person.name}’s phone`);
      onDone();
    },
    onError: (err) => {
      setErrors(fieldErrors(err));
      toast.error(err instanceof ApiError ? err.message : 'Could not save it.');
    },
  });
  const submit = () => {
    const from = parseClock(start);
    const to = parseClock(end);
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = 'Give it a name.';
    if (days.length === 0) found.days = 'Pick at least one day.';
    if (from === null) found.start = 'Choose a start time.';
    if (to === null) found.end = 'Choose an end time.';
    else if (from === to) found.end = 'The end has to be a different time from the start.';
    setErrors(found);
    if (Object.keys(found).length > 0 || from === null || to === null) return;
    save.mutate({ name: name.trim(), days, start: from, end: to, allowed });
  };
  const toggle = (list: number[], day: number) => (list.includes(day) ? list.filter((d) => d !== day) : [...list, day]);
  const id = `schedule-${schedule?.id ?? 'new'}`;
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      {schedule ? null : (
        <div className="flex flex-wrap gap-1.5">
          {SCHEDULE_PRESETS.map((preset) => (
            <Button
              key={preset.name}
              type="button"
              size="sm"
              variant={name === preset.name ? 'secondary' : 'outline'}
              className="h-7 px-2 text-xs"
              onClick={() => {
                setName(preset.name);
                setDays([...preset.days]);
                setStart(clockValue(preset.start));
                setEnd(clockValue(preset.end));
              }}
            >
              {preset.name}
            </Button>
          ))}
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="text-xs font-medium">
          Name
        </label>
        <Input
          id={`${id}-name`}
          className="h-9 text-sm"
          value={name}
          maxLength={40}
          aria-invalid={!!errors.name}
          onChange={(e) => setName(e.target.value)}
        />
        {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
      </div>
      <div className="space-y-1">
        <span className="text-xs font-medium">Days</span>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Days">
          {SCHEDULE_DAYS.map((label, day) => (
            <button
              key={day}
              type="button"
              aria-pressed={days.includes(day)}
              onClick={() => setDays((d) => toggle(d, day))}
              className={cn(
                'size-8 rounded-md border text-xs font-medium transition-colors',
                days.includes(day) ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent',
              )}
            >
              {label}
            </button>
          ))}
          <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setDays(WEEKDAYS)}>
            Weekdays
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs" onClick={() => setDays(EVERY_DAY)}>
            Every day
          </Button>
        </div>
        {errors.days ? <p className="text-xs text-destructive">{errors.days}</p> : null}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor={`${id}-start`} className="text-xs font-medium">
            From
          </label>
          <Input
            id={`${id}-start`}
            type="time"
            className="h-9 text-sm"
            value={start}
            aria-invalid={!!errors.start}
            onChange={(e) => setStart(e.target.value)}
          />
          {errors.start ? <p className="text-xs text-destructive">{errors.start}</p> : null}
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-end`} className="text-xs font-medium">
            To
          </label>
          <Input
            id={`${id}-end`}
            type="time"
            className="h-9 text-sm"
            value={end}
            aria-invalid={!!errors.end}
            onChange={(e) => setEnd(e.target.value)}
          />
          {errors.end ? <p className="text-xs text-destructive">{errors.end}</p> : null}
        </div>
      </div>
      {parseClock(end) !== null && parseClock(start) !== null && parseClock(end)! < parseClock(start)! ? (
        <p className="text-xs text-muted-foreground">It ends the next morning.</p>
      ) : null}
      {apps.length > 0 ? (
        <div className="space-y-1">
          <span className="text-xs font-medium">Still open (calls and messages always are)</span>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {apps.map((a) => (
              <li key={a.app}>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="size-4 rounded border-input"
                    checked={allowed.includes(a.app)}
                    disabled={!allowed.includes(a.app) && allowed.length >= MAX_ALLOWED}
                    onChange={(e) =>
                      setAllowed((list) => (e.target.checked ? [...list, a.app] : list.filter((x) => x !== a.app)))
                    }
                  />
                  <AppIcon app={{ app: a.app, label: a.label, icon: a.icon, minutes: 0 }} />
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" size="sm" className="h-8 text-xs" disabled={save.isPending} onClick={submit}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * Points for screen time: whether they may spend points on more time, what a
 * point buys and the most a day; their points to spend and today's extra
 * minutes; and Give extra time. Only while the household uses Points.
 */
function PointsForTime({ person }: { person: Person }) {
  const queryClient = useQueryClient();
  const { available, rule, balanceCenti, bought, given } = person.pointsTime;
  const save = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (body: { minutesPerPoint: number | null; dailyCap: number }) =>
      apiFetch<LookAfterDTO>('/api/supervision/points-time', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, ...body }),
      }),
    onSuccess: (next, body) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(
        body.minutesPerPoint === null
          ? `${person.name} can no longer spend points on screen time`
          : `${person.name} can spend points on screen time`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  const give = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (minutes: number) =>
      apiFetch<LookAfterDTO>('/api/supervision/extra-time', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, minutes }),
      }),
    onSuccess: (next, minutes) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(`${person.name} has ${formatMinutes(minutes)} more today`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not give it.'),
  });
  if (!available) return null;
  const pending = save.isPending ? save.variables : null;
  const rate = pending ? pending.minutesPerPoint : (rule?.minutesPerPoint ?? null);
  const cap = pending ? pending.dailyCap : (rule?.dailyCap ?? 30);
  const hasLimits = !!person.limits.total || person.limits.apps.length > 0;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Points for screen time</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={rate !== null}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ minutesPerPoint: e.target.checked ? 5 : null, dailyCap: cap })}
        />
        Let them spend points on more time
        {save.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      </label>
      {rate !== null ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>1 point buys</span>
          <Select
            aria-label="What one point buys"
            className="h-8 w-auto px-2 py-0 text-xs"
            value={String(rate)}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ minutesPerPoint: Number(e.target.value), dailyCap: cap })}
          >
            {[...new Set([...RATE_CHOICES, rate])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {formatMinutes(m)}
              </option>
            ))}
          </Select>
          <span>up to</span>
          <Select
            aria-label="The most they can buy a day"
            className="h-8 w-auto px-2 py-0 text-xs"
            value={String(cap)}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ minutesPerPoint: rate, dailyCap: Number(e.target.value) })}
          >
            {[...new Set([...CAP_CHOICES, cap])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>
                {formatMinutes(m)}
              </option>
            ))}
          </Select>
          <span>a day</span>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {formatPoints(Math.max(0, balanceCenti))} points to spend
        {bought > 0 ? ` · bought ${formatMinutes(bought)} today` : ''}
        {given > 0 ? ` · given ${formatMinutes(given)} today` : ''}
        {rule ? (
          <>
            {' · '}set by {rule.byName} <RelativeTime date={rule.at} />
          </>
        ) : null}
      </p>
      {hasLimits ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>Give extra time today:</span>
          {GIVE_STEPS.map((m) => (
            <Button
              key={m}
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={give.isPending}
              onClick={() => give.mutate(m)}
            >
              {give.isPending && give.variables === m ? <Loader2 className="animate-spin" /> : null}+
              {formatMinutes(m)}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Extra time goes on top of their daily limits, and they have none yet.
        </p>
      )}
    </div>
  );
}

interface RingButtonProps {
  person: Person;
  /** When the viewer's last ring from this page stops resting the button (0: none). */
  until: number;
  onRang: (until: number) => void;
}

/** Rings their phone. On their card and on their page. */
function RingButton({ person, until, onRang }: RingButtonProps) {
  const queryClient = useQueryClient();
  // Rests while the phone rings, so a second tap can't be refused by the
  // server; until their phone says the ring ended, when the server allows another.
  const [now, setNow] = useState(() => Date.now());
  const ringEnded = person.ring?.phase === 'stopped' || person.ring?.phase === 'rang_out';
  const ringing = now < until && !ringEnded;
  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => setNow(Date.now()), until - now);
    return () => clearTimeout(t);
  }, [ringing, until, now]);

  const ring = useMutation({
    // A refetch already on its way mustn't put the last ring back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: () =>
      apiFetch<{ rung: boolean; ring: RingDTO }>('/api/supervision/ring', {
        method: 'POST',
        body: JSON.stringify({ targetId: person.id }),
      }),
    onSuccess: ({ ring }) => {
      const at = Date.now();
      // The new ring at once, so the last one's ending doesn't free the button;
      // the page then looks every few seconds for what their phone says.
      queryClient.setQueryData<LookAfterDTO>(LOOK_AFTER_KEY, (d) =>
        d ? { ...d, people: d.people.map((p) => (p.id === person.id ? { ...p, ring } : p)) } : d,
      );
      setNow(at);
      onRang(at + RING_MS);
      toast.success(`Ringing ${person.name}’s phone`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not ring their phone.'),
  });

  return (
    <Button size="sm" variant="outline" disabled={ring.isPending || ringing} onClick={() => ring.mutate()}>
      {ring.isPending ? <Loader2 className="animate-spin" /> : <BellRing />}
      {ringing ? 'Ringing' : 'Ring'}
    </Button>
  );
}

/**
 * Everything about one person: their phone, Ring, the Location required and
 * Share app usage boxes, their app usage, a box per protection their phone
 * must have on, and how far Set up this phone has got.
 */
function PersonDetail({ person, canRing, until, onRang }: RingButtonProps & { canRing: boolean }) {
  const queryClient = useQueryClient();

  // A refetch already on its way (window focus) mustn't put the old value back.
  const cancelRefetch = () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY });

  const require = useMutation({
    onMutate: cancelRefetch,
    mutationFn: (required: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/sharing', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, required }),
      }),
    onSuccess: (next, required) => {
      // Set before the pending state ends, so the box never flicks back.
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      // Who may be checked changes with it.
      queryClient.invalidateQueries({ queryKey: LIVE_CHECKS_KEY });
      toast.success(
        required ? `${person.name}’s location sharing is now required` : `${person.name} can turn sharing off again`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });

  const usage = useMutation({
    onMutate: cancelRefetch,
    mutationFn: (share: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/usage', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, share }),
      }),
    onSuccess: (next, share) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(share ? `${person.name}’s app usage will be shared` : `${person.name}’s app usage is no longer shared`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });

  const required = require.isPending ? require.variables : person.sharing === 'required';
  const sharesUsage = usage.isPending ? usage.variables : person.appUsage.shared;
  const sharingNote =
    person.sharing === 'required' ? null : person.sharing === 'on' ? 'Shares their location' : 'Not sharing their location';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          {sharingNote ? <span className="block text-xs text-muted-foreground">{sharingNote}</span> : null}
          <PhoneLine phone={person.phone} />
          {person.ring ? <RingLine ring={person.ring} /> : null}
        </span>
        {canRing ? <RingButton person={person} until={until} onRang={onRang} /> : null}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={required}
          disabled={require.isPending}
          onChange={(e) => require.mutate(e.target.checked)}
        />
        Location required
        {require.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 rounded border-input"
          checked={sharesUsage}
          disabled={usage.isPending}
          onChange={(e) => usage.mutate(e.target.checked)}
        />
        Share app usage
        {usage.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
      </label>
      {person.appUsage.shared ? <UsageLine person={person} /> : null}
      <BlockedApps person={person} />
      <DailyLimits person={person} />
      <Schedules person={person} />
      <PointsForTime person={person} />
      {PHONE_RULES.map((rule) => (
        <RuleBox key={rule} person={person} rule={rule} />
      ))}
      <SetupProgress person={person} />
    </div>
  );
}

/** One protection their phone must have on, saved with each tick. */
function RuleBox({ person, rule }: { person: LookAfterDTO['people'][number]; rule: PhoneRule }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    // A refetch already on its way (window focus) mustn't put the old value back.
    onMutate: () => queryClient.cancelQueries({ queryKey: LOOK_AFTER_KEY }),
    mutationFn: (required: boolean) =>
      apiFetch<LookAfterDTO>('/api/supervision/phone-rules', {
        method: 'POST',
        body: JSON.stringify({ supervisedId: person.id, rule, required }),
      }),
    onSuccess: (next, required) => {
      queryClient.setQueryData(LOOK_AFTER_KEY, next);
      toast.success(
        required
          ? `${PHONE_RULE_LABELS[rule]} is now required on ${person.name}’s phone`
          : `${PHONE_RULE_LABELS[rule]} is no longer required on ${person.name}’s phone`,
      );
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change it.'),
  });
  const checked = save.isPending ? save.variables : person.rules[rule];
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 rounded border-input"
        checked={checked}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.checked)}
      />
      Require {PHONE_RULE_LABELS[rule]}
      {save.isPending ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
    </label>
  );
}
