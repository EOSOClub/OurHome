import * as React from 'react';
import { cn } from '@/lib/utils';

/** Styled native select - no extra dependency, fully touch/keyboard friendly. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      // aria-invalid marks a field whose value is the problem (red border and ring), as on Input.
      'flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';
