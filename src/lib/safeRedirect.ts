/**
 * Where to go after signing in. Only same-origin, absolute paths are
 * followed; anything else (an external URL, protocol-relative `//host`, or
 * `/\host`, which browsers read as `//host`) falls back to the dashboard, so
 * a `?redirect=` link can't send someone to another site after a real
 * sign-in. Used by the login page (already signed in) and the login form
 * (just signed in).
 */
export function safeRedirect(target: string | null | undefined): string {
  if (
    target &&
    target.startsWith('/') &&
    !target.startsWith('//') &&
    !target.startsWith('/\\') &&
    // Control characters (tab, newline) are stripped by URL parsing, which
    // can turn "/\t/host" into "//host".
    !/[\u0000-\u001f\u007f]/.test(target)
  ) {
    return target;
  }
  return '/dashboard';
}
