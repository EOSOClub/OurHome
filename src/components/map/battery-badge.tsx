import { Battery, BatteryCharging, BatteryLow } from 'lucide-react';
import { batteryLabel, type BatteryReading } from '@/lib/location';
import { cn } from '@/lib/utils';

/**
 * A member's phone battery next to where they are: "85%", "12%, 3 h ago".
 * Muted, or red when low (so a caller's color can't hide that).
 */
export function BatteryBadge({ battery, className }: { battery: BatteryReading; className?: string }) {
  const { text, low } = batteryLabel(battery);
  const Icon = low ? BatteryLow : battery.charging ? BatteryCharging : Battery;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-xs',
        className,
        low ? 'font-medium text-destructive' : 'text-muted-foreground',
      )}
      title={`Phone battery: ${text}`}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="sr-only">Phone battery </span>
      {text}
    </span>
  );
}
