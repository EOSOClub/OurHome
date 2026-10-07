// Home-network helpers. The app is reached two ways: over plain HTTP on the LAN
// (http://192.168.1.20:3000, http://homeserver:3000) and, optionally, over HTTPS
// through a tunnel or reverse proxy. These decide which one a request is.

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback, RFC 1918, link-local, CGNAT (Tailscale) and IPv6 ULA/link-local. */
export function isPrivateIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);

  const v4 = IPV4.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!ip.includes(':')) return false;
  return ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/**
 * A hostname that only resolves inside the home network: a private IP,
 * localhost, a single-label name (`homeserver`) or a local suffix.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (isPrivateIp(host)) return true;
  if (IPV4.test(host) || host.includes(':')) return false; // a public IP
  if (!host.includes('.')) return true;
  return ['.localhost', '.local', '.lan', '.home.arpa', '.internal'].some((s) =>
    host.endsWith(s),
  );
}

/** The hostname from a Host header value (`192.168.1.20:3000`, `[::1]:3000`). */
export function hostnameOf(host: string): string {
  const v6 = /^\[([^\]]+)\]/.exec(host);
  return (v6 ? v6[1] : host.replace(/:\d+$/, '')).toLowerCase();
}

/** This machine itself: localhost, 127.x.x.x or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * The browser reached us over HTTPS. A tunnel or proxy terminates TLS and
 * forwards plain HTTP, so trust its forwarded scheme.
 */
export function isHttpsRequest(headers: Headers, url?: string): boolean {
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https') return true;
  if (headers.get('cf-visitor')?.includes('"https"')) return true;
  return url?.startsWith('https://') ?? false;
}

/**
 * The request came from a device on the home network, not the internet.
 * Anything through Cloudflare carries `cf-connecting-ip`. A reverse proxy
 * records the real client in at least one of the other headers, but may pass a
 * client-supplied value through in another, so every address in every header
 * must be private. With no proxy headers at all the request reached the port
 * directly, which the deploy docs keep to the home network.
 */
export function isFromLocalNetwork(headers: Headers): boolean {
  if (headers.get('cf-connecting-ip')) return false;
  const addresses = [
    ...(headers.get('x-forwarded-for')?.split(',') ?? []),
    ...(headers.get('x-real-ip') ? [headers.get('x-real-ip')!] : []),
    // RFC 7239: Forwarded: for=203.0.113.9;proto=https, for="[2001:db8::1]:443"
    ...[...(headers.get('forwarded') ?? '').matchAll(/for="?([^";,]+)/gi)].map((m) =>
      m[1].replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/^([\d.]+):\d+$/, '$1'),
    ),
  ];
  return addresses.every((ip) => isPrivateIp(ip));
}
