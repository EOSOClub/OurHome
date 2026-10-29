// Client-side fetch helper that unwraps the { ok, data } envelope from the API
// layer (see src/server/api/http.ts) and throws a useful error otherwise.

export interface ApiErrorShape {
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  details?: unknown;
  status: number;
  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * The first error for each field a failed form sent back (a 422 from
 * validationFailed in server/api/http.ts, or a 409 naming its field, like a
 * username already taken), so the form can mark those fields; empty for any
 * other failure.
 */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  const fields = (err.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors;
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fields ?? {})) {
    if (messages?.[0]) out[key] = messages[0];
  }
  return out;
}

export async function apiFetch<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: ApiErrorShape }
    | null;

  // `body.ok === false`, not `!body.ok`, on purpose: a reply without an `ok`
  // field isn't an error envelope, and reading `body.error` from it would throw.
  // noinspection PointlessBooleanExpressionJS
  if (!res.ok || !body || body.ok === false) {
    // noinspection PointlessBooleanExpressionJS
    const err =
      body && body.ok === false ? body.error : { message: res.statusText };
    throw new ApiError(err.message, res.status, err.details);
  }

  return body.data;
}
