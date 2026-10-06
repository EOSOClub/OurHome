/**
 * Segment-level loading skeleton shown while server components for a route
 * under (app) render. Pure markup — mirrors the card layout most pages use.
 */
export default function Loading() {
  return (
    <div className="animate-pulse space-y-6" aria-hidden>
      <div className="space-y-2">
        <div className="h-7 w-48 rounded-md bg-muted" />
        <div className="h-4 w-64 rounded-md bg-muted" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <div className="size-10 shrink-0 rounded-lg bg-muted" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-5 w-10 rounded bg-muted" />
              <div className="h-3 w-16 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-card p-5 shadow-sm"
          >
            <div className="mb-4 h-5 w-32 rounded bg-muted" />
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-4 w-3/4 rounded bg-muted" />
                    <div className="h-3 w-1/3 rounded bg-muted" />
                  </div>
                  <div className="h-5 w-14 shrink-0 rounded-full bg-muted" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
