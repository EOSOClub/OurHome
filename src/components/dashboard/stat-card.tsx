import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'default',
  href,
}: {
  label: string;
  value: number | string;
  icon: LucideIcon;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  href?: string;
}) {
  const toneClass = {
    default: 'text-primary bg-primary/10',
    danger: 'text-destructive bg-destructive/10',
    warning: 'text-[var(--color-warning)] bg-[var(--color-warning)]/10',
    success: 'text-[var(--color-success)] bg-[var(--color-success)]/10',
  }[tone];

  const card = (
    <Card
      className={cn(
        'flex items-center gap-3 p-4',
        href && 'transition-colors hover:border-primary/50 hover:bg-accent/40',
      )}
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg',
          toneClass,
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight">{value}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );

  if (!href) return card;

  return (
    <Link
      href={href}
      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {card}
    </Link>
  );
}
