import Link from 'next/link';
import { History } from 'lucide-react';
import { requireUser } from '@/server/auth/session';
import { listActivity } from '@/server/services/activityService';
import { getPointsSettings } from '@/server/services/pointsService';
import { listMembers } from '@/server/services/userService';
import { EmptyState } from '@/components/empty-state';
import { Card, CardContent } from '@/components/ui/card';
import {
  ACTIVITY_AREAS,
  ACTIVITY_AREA_LABELS,
  isActivityArea,
  type ActivityArea,
} from '@/lib/activityAreas';
import { cn } from '@/lib/utils';

// The household's activity log (moved off the dashboard): every change anyone
// made, newest first, filtered by area and person. Filters and paging are
// plain links, so the page needs no client code.

type Params = { area?: string | string[]; user?: string | string[]; before?: string | string[] };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireUser();
  const params = await searchParams;
  const areaParam = one(params.area);
  const area = areaParam && isActivityArea(areaParam) ? areaParam : undefined;
  const actorId = one(params.user) || undefined;
  const before = one(params.before) || undefined;

  const [page, members, settings] = await Promise.all([
    listActivity(user.householdId!, { area, actorId, before }),
    listMembers(user.householdId!),
    getPointsSettings(user.householdId!),
  ]);

  const href = (next: { area?: ActivityArea; user?: string; before?: string }) => {
    const q = new URLSearchParams();
    if (next.area) q.set('area', next.area);
    if (next.user) q.set('user', next.user);
    if (next.before) q.set('before', next.before);
    const s = q.toString();
    return s ? `/activity?${s}` : '/activity';
  };

  const dayKey = (d: Date) =>
    d.toLocaleDateString('en-CA', { timeZone: settings.timezone });
  const now = new Date();
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const groups: { label: string; items: typeof page.items }[] = [];
  for (const entry of page.items) {
    const key = dayKey(entry.createdAt);
    const label =
      key === todayKey
        ? 'Today'
        : key === yesterdayKey
          ? 'Yesterday'
          : entry.createdAt.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              timeZone: settings.timezone,
            });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(entry);
    else groups.push({ label, items: [entry] });
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-muted-foreground">Everything that changed around the house.</p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <Chip href={href({ user: actorId })} active={!area}>
            All
          </Chip>
          {ACTIVITY_AREAS.map((a) => (
            <Chip key={a} href={href({ area: a, user: actorId })} active={area === a}>
              {ACTIVITY_AREA_LABELS[a]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip href={href({ area })} active={!actorId}>
            Everyone
          </Chip>
          {members.map((m) => (
            <Chip key={m.id} href={href({ area, user: m.id })} active={actorId === m.id}>
              {m.id === user.id ? 'Me' : m.name}
            </Chip>
          ))}
        </div>
      </div>

      {page.items.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing here yet"
          description={area || actorId ? 'Try another filter.' : 'Changes around the house will show up here.'}
        />
      ) : (
        groups.map((g) => (
          <section key={g.label} className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.label}</h2>
            <Card>
              <CardContent className="py-1">
                <ul className="divide-y divide-border">
                  {g.items.map((entry) => {
                    const target = activityHref(entry.subjectType, entry.subjectId);
                    const body = (
                      <p className="text-sm">
                        <span className="font-medium">{entry.actor?.name ?? 'System'}</span>{' '}
                        <span className={target ? 'group-hover:underline' : undefined}>{entry.message}</span>
                      </p>
                    );
                    return (
                      <li key={entry.id} className="flex items-baseline gap-3 py-2.5">
                        <span className="w-16 shrink-0 text-xs tabular-nums text-muted-foreground">
                          {entry.createdAt.toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZone: settings.timezone,
                          })}
                        </span>
                        {target ? (
                          <Link href={target} className="group min-w-0 flex-1">
                            {body}
                          </Link>
                        ) : (
                          <div className="min-w-0 flex-1">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </section>
        ))
      )}

      {before || page.nextBefore ? (
        <div className="flex justify-between text-sm">
          {before ? (
            <Link href={href({ area, user: actorId })} className="text-primary hover:underline">
              ← Newest
            </Link>
          ) : (
            <span />
          )}
          {page.nextBefore ? (
            <Link
              href={href({ area, user: actorId, before: page.nextBefore })}
              className="text-primary hover:underline"
            >
              Older →
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {children}
    </Link>
  );
}

/** Route for an entry's subject, when a sensible one exists. */
function activityHref(subjectType: string, subjectId: string | null): string | null {
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
    case 'event':
      return '/calendar';
    case 'request':
      return '/requests';
    default:
      return null;
  }
}
