'use client';

import { useState } from 'react';
import type { ChangelogEntry } from '@/lib/changelog';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** "2026-10-29" as "October 29, 2026" (a calendar date, so no time zone). */
function releaseDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "What's new" after an update: the entries they haven't closed yet (newest
 * first, from the layout). Closing it, either way, marks the newest one seen
 * on the server, so it doesn't show again here or in the app.
 */
export function WhatsNew({ entries }: { entries: ChangelogEntry[] }) {
  const [open, setOpen] = useState(true);

  function close() {
    setOpen(false);
    // A failed save just shows it again on the next full page load.
    apiFetch('/api/changelog/seen', { method: 'POST', body: JSON.stringify({ id: entries[0].id }) }).catch(() => {});
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="What's new"
      description="Changes since you last looked."
      footer={<Button onClick={close}>Got it</Button>}
    >
      <div className="max-h-[60vh] space-y-5 overflow-y-auto">
        {entries.map((e) => (
          <section key={e.id}>
            <h3 className="text-sm font-semibold">{e.title}</h3>
            <p className="text-xs text-muted-foreground">{releaseDate(e.date)}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {e.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
