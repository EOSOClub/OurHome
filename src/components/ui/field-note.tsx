/**
 * Under a field: what's wrong with it (red), or its hint. Give the field
 * aria-describedby={id} so a screen reader reads it out with the field, and
 * aria-invalid when there's an error (Input, Select and Textarea turn red).
 */
export function FieldNote({ id, error, hint }: { id: string; error?: string | null; hint?: string }) {
  if (!error && !hint) return null;
  return (
    <p id={id} className={'text-xs ' + (error ? 'text-destructive' : 'text-muted-foreground')}>
      {error ?? hint}
    </p>
  );
}
