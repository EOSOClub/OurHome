import { PROFILE_COLORS, initials, type ProfileColor } from '@/lib/profile';
import { cn } from '@/lib/utils';

/** A member's chosen emoji (or initials) on their chosen colour. */
export function ProfileAvatar({
  name,
  emoji,
  color,
  size = 'md',
}: {
  name: string;
  emoji: string | null;
  color: ProfileColor | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const hex = PROFILE_COLORS[color ?? 'slate'];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white',
        size === 'sm' && 'size-8 text-sm',
        size === 'md' && 'size-10 text-base',
        size === 'lg' && 'size-14 text-2xl',
      )}
      // Emoji sit on a soft tint of the colour; initials on the solid colour.
      style={{ backgroundColor: emoji ? `${hex}33` : hex, boxShadow: `inset 0 0 0 2px ${hex}` }}
    >
      {emoji ?? initials(name)}
    </span>
  );
}
