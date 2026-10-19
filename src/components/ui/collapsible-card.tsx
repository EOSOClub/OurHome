'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** True inside a grouped CollapsibleCard: a SectionCard then sits under a divider instead of in a card of its own. */
const GroupedSection = React.createContext(false);

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

/**
 * A card whose body folds away under its title: the title row is a button
 * that opens or closes it. For long blocks; short ones stay a plain Card.
 * Starts closed unless `defaultOpen`, and opens by itself whenever `openWhen`
 * turns true (something inside needs seeing). The body stays mounted while
 * closed, so a half-filled form keeps what was typed. With `group`, the
 * SectionCards inside sit under dividers in this one card.
 *
 * The title row is a button, so nothing clickable goes in `description`.
 * Header buttons (Add, New) go in `actions`, beside it: they show while closed
 * and open the card when used, so what they add is in view. Dialogs go in
 * `dialogs`, outside the folding body (they render in place, so a closed body
 * would hide them).
 */
export function CollapsibleCard({
  title,
  icon,
  description,
  actions,
  dialogs,
  defaultOpen = false,
  openWhen = false,
  group = false,
  id,
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  dialogs?: React.ReactNode;
  defaultOpen?: boolean;
  openWhen?: boolean;
  group?: boolean;
  id?: string;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  // A link to the card (/settings#map-places) opens it.
  const hash = React.useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const wanted = openWhen || (!!id && hash === `#${id}`);
  const [open, setOpen] = React.useState(defaultOpen || wanted);
  // Opened during render when `wanted` turns true, not in an effect, so it never shows closed first.
  const [wasWanted, setWasWanted] = React.useState(wanted);
  if (wanted !== wasWanted) {
    setWasWanted(wanted);
    if (wanted) setOpen(true);
  }
  const bodyId = React.useId();
  return (
    <Card id={id} className={className}>
      {/* On a phone the actions go under the title, rather than squeezing it into a narrow column. */}
      <div className="flex flex-col sm:flex-row sm:items-start">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((o) => !o)}
            className="flex w-full items-start gap-3 rounded-lg p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex-1 space-y-1.5">
              <span className="flex items-center gap-2 text-base font-semibold leading-none tracking-tight">
                {icon}
                {title}
              </span>
              {description ? <span className="block text-sm text-muted-foreground">{description}</span> : null}
            </span>
            <ChevronDown
              aria-hidden
              className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
            />
          </button>
        </h3>
        {actions ? (
          <div className="flex shrink-0 gap-2 px-5 pb-4 sm:py-4 sm:pl-0" onClickCapture={() => setOpen(true)}>
            {actions}
          </div>
        ) : null}
      </div>
      <div id={bodyId} hidden={!open}>
        <CardContent className={cn(group && 'space-y-5', contentClassName)}>
          <GroupedSection.Provider value={group}>{children}</GroupedSection.Provider>
        </CardContent>
      </div>
      {dialogs}
    </Card>
  );
}

/**
 * A card with a title, used on its own or inside a grouped CollapsibleCard,
 * where it drops its frame and sits under a divider.
 */
export function SectionCard({
  title,
  icon,
  description,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  description?: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const grouped = React.useContext(GroupedSection);
  if (grouped) {
    return (
      <section className="space-y-3 border-t border-border pt-4">
        <div className="space-y-1">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            {icon}
            {title}
          </h4>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className={contentClassName}>{children}</div>
      </section>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
