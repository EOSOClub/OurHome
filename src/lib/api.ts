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

  if (!res.ok || !body || body.ok === false) {
    const err =
      body && body.ok === false ? body.error : { message: res.statusText };
    throw new ApiError(err.message, res.status, err.details);
  }

  return body.data;
}
