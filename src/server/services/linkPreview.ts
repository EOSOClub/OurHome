// Best-effort Open Graph preview fetcher. Given a pasted product URL it pulls
// the title / image / price out of the page's <head> meta tags so the shopping
// form can pre-fill itself. Everything here degrades to nulls on failure — many
// sites (Amazon in particular) serve a bot wall instead of the real page, and
// that's expected: the UI just falls back to manual entry.

import { lookup } from 'node:dns/promises';
import type { LinkPreviewDTO } from '@/lib/types';

const EMPTY: LinkPreviewDTO = { title: null, imageUrl: null, price: null };

const FETCH_TIMEOUT_MS = 6_000;
// Redirects are followed manually so each hop can be re-validated; cap the count.
const MAX_REDIRECTS = 5;
// We only need the <head>, so cap the download instead of slurping whole pages.
const MAX_BYTES = 512 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreviewDTO> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return EMPTY;
  }

  try {
    const res = await safeFetch(url);
    if (!res) return EMPTY;
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !res.body || !/\b(text\/html|application\/xhtml)/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      return EMPTY;
    }
    const html = await readCapped(res.body, MAX_BYTES);
    return parsePreview(html, res.url || url.href);
  } catch {
    // Timeouts, connection resets, bot walls, DNS errors — all best-effort.
    return EMPTY;
  }
}

/**
 * SSRF-guarded fetch. Redirects are followed manually so the guard runs on every
 * hop (a public URL that 302s to an internal target can't slip through), and the
 * hostname is resolved so a public name pointing at a private IP is rejected too.
 *
 * Residual risk: a TOCTOU/DNS-rebinding window remains between the lookup and the
 * connection. That is acceptable here — the only callers are authenticated
 * household members, and the high-value bypasses (redirect-to-internal and
 * private A records) are closed.
 */
async function safeFetch(initial: URL): Promise<Response | null> {
  // One deadline shared across all hops so redirect chains can't extend it.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = initial;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isPublicFetchTarget(url))) return null;

    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (res.status < 300 || res.status >= 400) return res;

    // Redirect: validate the next hop before following it.
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) return null;
    try {
      url = new URL(location, url);
    } catch {
      return null;
    }
  }
  return null; // too many redirects
}

/**
 * True when `url` is safe to fetch from the server on someone's behalf (also
 * used for a household's Paperless address): http(s) only, not an obvious internal name,
 * and every DNS-resolved address is outside the loopback / private / link-local
 * (incl. 169.254.169.254 metadata) and CGNAT ranges.
 */
export async function isPublicFetchTarget(url: URL): Promise<boolean> {
  if (!isFetchableUrl(url)) return false;
  try {
    const addrs = await lookup(normalizeHost(url.hostname), { all: true });
    if (addrs.length === 0) return false;
    return addrs.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false; // unresolvable host — don't fetch
  }
}

/** Protocol + literal-host SSRF checks (DNS resolution happens separately). */
function isFetchableUrl(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }
  return !isPrivateIp(normalizeHost(host));
}

/** URL.hostname wraps IPv6 literals in brackets; strip them for IP comparison. */
function normalizeHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** True for loopback / private / link-local / unique-local / CGNAT addresses. */
function isPrivateIp(ip: string): boolean {
  const addr = ip.toLowerCase();
  // IPv4 (also unwrap IPv4-mapped IPv6, e.g. ::ffff:192.168.0.1).
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const m = (mapped?.[1] ?? addr).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6.
  if (addr === '::1' || addr === '::') return true; // loopback / unspecified
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
  return false;
}

/** Read a response body up to `maxBytes`, stopping early once `</head>` lands. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = '';
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>')) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html;
}

function parsePreview(html: string, baseUrl: string): LinkPreviewDTO {
  const title =
    metaContent(html, 'og:title') ??
    metaContent(html, 'twitter:title') ??
    titleTag(html);
  const image =
    metaContent(html, 'og:image:secure_url') ??
    metaContent(html, 'og:image') ??
    metaContent(html, 'twitter:image') ??
    metaContent(html, 'twitter:image:src');
  const price =
    metaContent(html, 'product:price:amount') ??
    metaContent(html, 'og:price:amount');

  return {
    title: cleanText(title),
    imageUrl: resolveImage(image, baseUrl),
    price: parsePrice(price),
  };
}

/** Find the `content` of a <meta> tag whose property|name equals `key`. */
function metaContent(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi);
  if (!tags) return null;
  const wanted = key.toLowerCase();
  for (const tag of tags) {
    const prop = attr(tag, 'property') ?? attr(tag, 'name');
    if (prop && prop.toLowerCase() === wanted) {
      const content = attr(tag, 'content');
      if (content) return content;
    }
  }
  return null;
}

/** Read an attribute value (single, double, or unquoted) from a single tag. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const m = tag.match(re);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1] : null;
}

function cleanText(value: string | null): string | null {
  if (!value) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 300 ? text.slice(0, 300) : text;
}

function resolveImage(raw: string | null, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const resolved = new URL(decodeEntities(raw.trim()), baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.href.length <= 2000 ? resolved.href : null;
  } catch {
    return null;
  }
}

function parsePrice(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)));
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}
