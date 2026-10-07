import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ListTodo,
  Package,
  Receipt,
  Repeat,
  ShoppingCart,
} from 'lucide-react';
import { requireUser } from '@/server/auth/session';
import { getDashboard } from '@/server/services/dashboardService';
import { StatCard } from '@/components/dashboard/stat-card';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  formatDueDate,
  formatMoney,
  formatRelativeTime,
  isOverdue,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AccessPage } from '@/lib/permissions';
import { getUserAccess } from '@/server/services/permissionService';

// Each shows only to people who may add on that page (Members → Permissions).
const quickActions: { href: string; label: string; icon: typeof ListTodo; page: AccessPage }[] = [
  { href: '/tasks', label: 'New task', icon: ListTodo, page: 'tasks' },
  { href: '/shopping', label: 'Add item', icon: ShoppingCart, page: 'shopping' },
  { href: '/bills', label: 'Log payment', icon: Receipt, page: 'bills' },
  { href: '/calendar', label: 'New event', icon: CalendarDays, page: 'calendar' },
];

export default async function DashboardPage() {
  const user = await requireUser();
  const [data, access] = await Promise.all([
    getDashboard(user.householdId!),
    getUserAccess(user),
  ]);
  const actions = quickActions.filter((a) => access[a.page].create);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold">Hi, {user.name.split(' ')[0]}</h1>
          <p className="text-sm text-muted-foreground">
            Here’s what’s happening around the house.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map(({ href, label, icon: Icon }) => (
            <Link
              key={label}
              href={href}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              <Icon /> {label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Pending"
          value={data.counts.pending}
          icon={ListTodo}
          href="/tasks"
        />
        <StatCard
          label="Overdue"
          value={data.counts.overdue}
          icon={AlertTriangle}
          tone={data.counts.overdue > 0 ? 'danger' : 'default'}
          href="/tasks"
        />
        <StatCard
          label="Recurring"
          value={data.counts.recurring}
          icon={Repeat}
          href="/tasks"
        />
        <StatCard
          label="Low stock"
          value={data.counts.lowInventory}
          icon={Package}
          tone={data.counts.lowInventory > 0 ? 'warning' : 'default'}
          href="/inventory"
        />
        <StatCard
          label="To buy"
          value={data.counts.openShopping}
          icon={ShoppingCart}
          href="/shopping"
        />
        <StatCard
          label="Bills due"
          value={data.counts.billsDue}
          icon={Receipt}
          tone={data.counts.billsDue > 0 ? 'warning' : 'default'}
          href="/bills"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <TaskListCard
          title="Overdue"
          icon={AlertTriangle}
          tasks={data.overdue}
          emptyTitle="Nothing overdue"
          emptyDescription="You’re all caught up."
        />
        <TaskListCard
          title="Upcoming (7 days)"
          icon={CalendarClock}
          tasks={data.upcoming}
          emptyTitle="No upcoming tasks"
          emptyDescription="Add a task to get started."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4" /> Recent activity
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.recentActivity.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No activity yet"
              description="Completed chores and changes will show up here."
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.recentActivity.map((entry) => {
                const href = activityHref(entry.subjectType, entry.subjectId);
                const body = (
                  <>
                    <p className="text-sm">
                      <span className="font-medium">
                        {entry.actor?.name ?? 'System'}
                      </span>{' '}
                      <span className={href ? 'group-hover:underline' : undefined}>
                        {entry.message}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRelativeTime(entry.createdAt)}
                    </p>
                  </>
                );
                return (
                  <li
                    key={entry.id}
                    className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    {href ? (
                      <Link href={href} className="group min-w-0 flex-1">
                        {body}
                      </Link>
                    ) : (
                      <div className="min-w-0 flex-1">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <ShoppingCart className="size-4" /> Shopping
              </span>
              <Link
                href="/shopping"
                className="text-xs font-medium text-primary hover:underline"
              >
                Open
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {data.shoppingLists.length === 0 ? (
              <EmptyState
                icon={ShoppingCart}
                title="No shopping lists yet"
                description="Create a grocery or supplies list to start adding items."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.shoppingLists.map((list) => (
                  <li
                    key={list.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <Link
                      href={`/shopping?list=${list.id}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {list.name}
                    </Link>
                    <Badge variant={list.openCount > 0 ? 'default' : 'secondary'}>
                      {list.openCount} to buy
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <CalendarDays className="size-4" /> Upcoming events
              </span>
              <Link
                href="/calendar"
                className="text-xs font-medium text-primary hover:underline"
              >
                Open
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {data.upcomingEvents.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                title="Nothing scheduled"
                description="Add events to your household calendar."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.upcomingEvents.map((event) => (
                  <li
                    key={`${event.eventId}-${event.start}`}
                    className="py-3 first:pt-0 last:pb-0"
                  >
                    <Link
                      href="/calendar"
                      className="group flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium group-hover:underline">
                          {event.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {event.allDay
                            ? new Date(event.start).toLocaleDateString(undefined, {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                              })
                            : new Date(event.start).toLocaleString(undefined, {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                          {event.location ? ` · ${event.location}` : ''}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Receipt className="size-4" /> Upcoming bills
              </span>
              <Link
                href="/bills"
                className="text-xs font-medium text-primary hover:underline"
              >
                Open
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {data.upcomingBills.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No unpaid bills"
                description="Bills you add or receive by email will show up here."
              />
            ) : (
              <ul className="divide-y divide-border">
                {data.upcomingBills.map((bill) => (
                  <li key={bill.id} className="py-3 first:pt-0 last:pb-0">
                    <Link
                      href={`/bills/${bill.id}`}
                      className="group flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium group-hover:underline">
                          {bill.name}
                        </p>
                        <p
                          className={
                            isOverdue(bill.dueDate)
                              ? 'text-xs text-destructive'
                              : 'text-xs text-muted-foreground'
                          }
                        >
                          {formatDueDate(bill.dueDate)}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-medium">
                        {formatMoney(bill.amount, bill.currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Route for an activity entry's subject, when a sensible one exists. */
function activityHref(
  subjectType: string,
  subjectId: string | null,
): string | null {
  switch (subjectType) {
    case 'task':
      return '/tasks';
    case 'bill':
      return subjectId ? `/bills/${subjectId}` : '/bills';
    case 'shopping_list':
    case 'shopping_item':
      return '/shopping';
    case 'inventory_item':
      return '/inventory';
    default:
      return null;
  }
}

function TaskListCard({
  title,
  icon: Icon,
  tasks,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  icon: typeof AlertTriangle;
  tasks: Array<{
    id: string;
    title: string;
    priority: string;
    dueDate: Date | null;
    assignee: { id: string; name: string } | null;
  }>;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {tasks.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title={emptyTitle}
            description={emptyDescription}
          />
        ) : (
          <ul className="divide-y divide-border">
            {tasks.map((task) => (
              <li key={task.id} className="py-3 first:pt-0 last:pb-0">
                <Link
                  href="/tasks"
                  className="group flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium group-hover:underline">
                      {task.title}
                    </p>
                    <p
                      className={
                        isOverdue(task.dueDate)
                          ? 'text-xs text-destructive'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      {formatDueDate(task.dueDate)}
                      {task.assignee ? ` · ${task.assignee.name}` : ''}
                    </p>
                  </div>
                  <Badge variant={priorityVariant(task.priority)}>
                    {task.priority}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function priorityVariant(
  priority: string,
): 'default' | 'secondary' | 'destructive' | 'warning' {
  switch (priority) {
    case 'urgent':
      return 'destructive';
    case 'high':
      return 'warning';
    case 'low':
      return 'secondary';
    default:
      return 'default';
  }
}
