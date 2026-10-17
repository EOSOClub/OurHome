import { ApiError } from '@/lib/api';

// Better Auth answers with a code but names no field. These turn its password
// refusals into plain words and the field they're about, the same shape as
// the app API's field errors (lib/api.ts fieldErrors), so a form can mark it.

interface AuthFailure {
  message?: string | null;
  code?: string | null;
  status?: number;
}

/** A refused password change (or reset) as an ApiError naming its field. [currentField]: the form's current-password key. */
export function passwordChangeError(error: AuthFailure, fallback: string, currentField = 'currentPassword'): ApiError {
  const code = error.code ?? '';
  const [message, field]: [string, string | null] =
    code === 'INVALID_PASSWORD'
      ? ['Your current password is incorrect.', currentField]
      : code === 'PASSWORD_TOO_SHORT'
        ? ['Your new password is too short: use at least 8 characters.', 'newPassword']
        : code === 'PASSWORD_TOO_LONG'
          ? ['Your new password is too long: use at most 128 characters.', 'newPassword']
          : [error.message || fallback, null];
  return new ApiError(message, error.status ?? 400, field ? { fieldErrors: { [field]: [message] } } : undefined);
}
