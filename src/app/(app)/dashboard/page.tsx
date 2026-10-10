import Link from 'next/link';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Inbox,
  ListTodo,
  Package,
  PartyPopper,
  Receipt,
  ShoppingCart,
  Trophy,
  Users,
} from 'lucide-react';
import { requireUser } from '@/server/auth/session';
import { getDashboard, type DashboardData } from '@/server/services/dashboardService';
import { getUserAccess } from '@/server/services/permissionService';
import { StatCard } from '@/components/dashboard/stat-card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDueDate, formatMoney, isOverdue } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AccessPage } from '@/lib/permissions';
import type { Feature } from '@/lib/features';

// Each shows only to people who may add on that page (Members → Permissions).
const quickActions: { href: string; label: string; icon: typeof ListTodo; page: AccessPage }[] = [
  { href: '/tasks', label: 'New task', icon: ListTodo, page: 'tasks' },
  { href: '/shopping', label: 'Add item', icon: ShoppingCart, page: 'shopping' },
  { href: '/bills', label: 'Log payment', icon: Receipt, page: 'bills' },
  { href: '/calendar', label: 'New event', icon: CalendarDays, page: 'calendar' },
  { href: '/requests', label: 'New request', icon: Inbox, page: 'requests' },
];

export default async function DashboardPage() {
  const user = await requireUser();
  const access = await getUserAccess(user);
  const data = await getDashboard({ id: user.id, householdId: user.householdId! }, access);
  const actions = quickActions.filter((a) => access[a.page].create);
  const now = new Date();
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: data.timezone }).format(now),
  );
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  // Cards for features the server admin turned off aren't shown at all.
  const on = (f: Feature) => data.features.includes(f);
  const showNeedsYou = on('tasks') || on('requests');
  const showComingUp = on('calendar') || on('bills');
  const showHousehold = on('tasks') || on('inventory') || on('shopping') || on('bills');

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {now.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              timeZone: data.timezone,
            })}
          </p>
          <h1 className="text-2xl font-semibold">
            {greeting}, {user.name.split(' ')[0]}
          </h1>
          {on('tasks') ? <DoneToday done={data.doneToday} /> : null}
        </div>
        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map(({ href, label, icon: Icon }) => (
              <Link key={label} href={href} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
                <Icon /> {label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {showNeedsYou ? <NeedsYouCard me={data.me} timeZone={data.timezone} /> : null}
          {showComingUp ? <ComingUpCard data={data} /> : null}
        </div>
        <div className="space-y-6">
          {on('points') ? <PointsCard points={data.me.points} userId={user.id} /> : null}
          {showHousehold ? <HouseholdCard counts={data.counts} features={data.features} /> : null}
        </div>
      </div>
    </div>
  );
}

function DoneToday({ done }: { done: DashboardData['doneToday'] }) {
  if (done.total === 0) {
    return <p className="text-sm text-muted-foreground">Nothing ticked off yet today.</p>;
  }
  const chores = done.total === 1 ? '1 task' : `${done.total} tasks`;
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <PartyPopper className="size-4 text-[var(--color-success)]" />
      {chores} done today{done.mine > 0 ? ` — ${done.mine === done.total ? 'all' : done.mine} by you` : ''}.
    </p>
  );
}

type Me = DashboardData['me'];
type DashTask = Me['today'][number];

// Rendered on the server (UTC there): every date shows in the household's zone.
function NeedsYouCard({ me, timeZone }: { me: Me; timeZone: string }) {
  const nothing =
    me.today.length === 0 && me.requests.length === 0 && me.openToAnyone.length === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4" /> Needs you
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        {nothing ? (
          <div className="flex items-center gap-3 rounded-lg bg-[var(--color-success)]/10 px-4 py-3 text-sm">
            <CheckCircle2 className="size-5 shrink-0 text-[var(--color-success)]" />
            <span>
              <span className="font-medium">You’re all caught up.</span>{' '}
              <span className="text-muted-foreground">Nothing is due on you today.</span>
            </span>
          </div>
        ) : null}
        {me.today.length > 0 ? <TaskList tasks={me.today} timeZone={timeZone} /> : null}
        {me.requests.length > 0 ? (
          <Section title="Requests">
            <ul className="divide-y divide-border">
              {me.requests.map((r) => (
                <li key={r.id} className="py-2.5 first:pt-0 last:pb-0">
                  <Link href="/requests" className="group flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium group-hover:underline">{requestTitle(r)}</p>
                      <p className="text-xs text-muted-foreground">from {r.requester.name}</p>
                    </div>
                    <RequestBadge reason={r.reason} dueAt={r.dueAt} timeZone={timeZone} />
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {me.openToAnyone.length > 0 ? (
          <Section title="Open to anyone">
            <TaskList tasks={me.openToAnyone} timeZone={timeZone} />
          </Section>
        ) : null}
        {me.later.length > 0 ? (
          <Section title="Later this week">
            <TaskList tasks={me.later} timeZone={timeZone} muted />
          </Section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function TaskList({ tasks, timeZone, muted = false }: { tasks: DashTask[]; timeZone: string; muted?: boolean }) {
  return (
    <ul className="divide-y divide-border">
      {tasks.map((task) => (
        <li key={task.id} className="py-2.5 first:pt-0 last:pb-0">
          <Link href="/tasks" className="group flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className={cn('truncate text-sm group-hover:underline', muted ? '' : 'font-medium')}>
                {task.title}
              </p>
              <p
                className={
                  isOverdue(task.dueDate, timeZone) ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
                }
              >
                {formatDueDate(task.dueDate, timeZone)}
                {task.place ? <span className="text-muted-foreground"> · {task.place}</span> : null}
              </p>
            </div>
            {!muted && (task.priority === 'urgent' || task.priority === 'high') ? (
              <Badge variant={task.priority === 'urgent' ? 'destructive' : 'warning'}>{task.priority}</Badge>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function requestTitle(r: Me['requests'][number]): string {
  if (r.category !== 'media') return r.title;
  const kind = r.mediaType === 'tv' ? 'TV' : 'Movie';
  return `${kind}: ${r.title}${r.year ? ` (${r.year})` : ''}${r.season ? ` · S${r.season}` : ''}`;
}

function RequestBadge({
  reason,
  dueAt,
  timeZone,
}: {
  reason: Me['requests'][number]['reason'];
  dueAt: Date | null;
  timeZone: string;
}) {
  switch (reason) {
    case 'approve':
      return <Badge>Mark added</Badge>;
    case 'accept':
      return <Badge>Accept</Badge>;
    case 'due':
      return <Badge variant="destructive">{isOverdue(dueAt, timeZone) ? 'Overdue' : 'Due today'}</Badge>;
  }
}

function PointsCard({ points, userId }: { points: Me['points']; userId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Trophy className="size-4" /> This week
          </span>
          <Link href="/points" className="text-xs font-medium text-primary hover:underline">
            Points
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div>
          <div className="text-3xl font-semibold leading-tight">
            {formatPoints(points.week)} <span className="text-base font-normal text-muted-foreground">pts</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {points.rank ? `#${points.rank} in the house` : 'No points yet this week'}
            {points.queued > 0 ? ` · ${formatPoints(points.queued)} waiting on unfinished tasks` : ''}
          </p>
        </div>
        {points.leaders.length > 0 ? (
          <ol className="space-y-1.5">
            {points.leaders.map((m, i) => (
              <li key={m.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className={cn('truncate', m.userId === userId && 'font-medium')}>
                  <span className="mr-2 text-muted-foreground">{i + 1}.</span>
                  {m.name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatPoints(m.points)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatPoints(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function HouseholdCard({ counts, features }: { counts: DashboardData['counts']; features: Feature[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" /> Around the house
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0">
        {features.includes('tasks') ? (
          <StatCard
            label="Overdue tasks"
            value={counts.overdue}
            icon={AlertTriangle}
            tone={counts.overdue > 0 ? 'danger' : 'default'}
            href="/tasks"
          />
        ) : null}
        {features.includes('inventory') ? (
          <StatCard
            label="Low stock"
            value={counts.lowInventory}
            icon={Package}
            tone={counts.lowInventory > 0 ? 'warning' : 'default'}
            href="/inventory"
          />
        ) : null}
        {features.includes('shopping') ? (
          <StatCard label="To buy" value={counts.openShopping} icon={ShoppingCart} href="/shopping" />
        ) : null}
        {features.includes('bills') ? (
          <StatCard
            label="Bills due (7d)"
            value={counts.billsDue}
            icon={Receipt}
            tone={counts.billsDue > 0 ? 'warning' : 'default'}
            href="/bills"
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Calendar events and unpaid bills, in date order. */
function ComingUpCard({ data }: { data: DashboardData }) {
  const rows = [
    ...data.upcomingEvents.map((e) => ({
      key: `event-${e.eventId}-${e.start}`,
      at: new Date(e.start),
      href: '/calendar',
      icon: CalendarDays,
      title: e.title,
      detail: [
        e.allDay
          ? new Date(e.start).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              timeZone: data.timezone,
            })
          : new Date(e.start).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              timeZone: data.timezone,
            }),
        e.location,
      ]
        .filter(Boolean)
        .join(' · '),
      late: false,
      trailing: null as string | null,
    })),
    ...data.upcomingBills.map((b) => ({
      key: `bill-${b.id}`,
      at: b.dueDate ? new Date(b.dueDate) : new Date(8.64e15),
      href: `/bills/${b.id}`,
      icon: Receipt,
      title: b.name,
      detail: formatDueDate(b.dueDate, data.timezone),
      late: isOverdue(b.dueDate, data.timezone),
      trailing: formatMoney(b.amount, b.currency),
    })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarDays className="size-4" /> Coming up
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {data.features.includes('calendar') && data.features.includes('bills')
              ? 'No events this week and no unpaid bills.'
              : data.features.includes('calendar')
                ? 'No events this week.'
                : 'No unpaid bills.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ key, href, icon: Icon, title, detail, late, trailing }) => (
              <li key={key} className="py-2.5 first:pt-0 last:pb-0">
                <Link href={href} className="group flex items-center gap-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium group-hover:underline">{title}</p>
                    <p className={late ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{detail}</p>
                  </div>
                  {trailing ? <span className="shrink-0 text-sm font-medium">{trailing}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
