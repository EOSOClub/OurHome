'use client';

import { useCallback, useEffect, useState } from 'react';

// Shared pages (Shopping, Inventory) poll so one person's changes reach
// everyone else. A poll that moves a row to another group (another member
// ticked it off, changed its category, restocked it under "Low only") remounts
// the row and threw away an edit form that was open in it. The view counts the
// edit forms open below it and holds off polling while there are any.

/** Told +1 when an edit form opens and -1 when it closes. */
export type ReportEditing = (delta: 1 | -1) => void;

/** In the view: whether any edit form is open, and the callback the forms report to. */
export function useEditingCount(): { editing: boolean; report: ReportEditing } {
  const [count, setCount] = useState(0);
  const report = useCallback<ReportEditing>((delta) => setCount((n) => Math.max(0, n + delta)), []);
  return { editing: count > 0, report };
}

/** In an edit form: counts as an open edit while it is mounted. */
export function useHoldsEditing(report: ReportEditing | undefined): void {
  useEffect(() => {
    if (!report) return;
    report(1);
    return () => report(-1);
  }, [report]);
}
