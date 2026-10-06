// Recognise Amazon product links and pull the ASIN (Amazon's 10-character
// product id) out of them. Pure string parsing of a URL the user pasted — no
// network access — so it's safe to use on both the server and the client.

// An ASIN is 10 uppercase alphanumerics (books reuse their ISBN-10 here).
const ASIN = '([A-Z0-9]{10})';

// The id can sit under a handful of product path shapes Amazon uses.
const ASIN_PATH_PATTERNS = [
  new RegExp(`/dp/${ASIN}`, 'i'),
  new RegExp(`/gp/product/${ASIN}`, 'i'),
  new RegExp(`/gp/aw/d/${ASIN}`, 'i'),
  new RegExp(`/dp/product/${ASIN}`, 'i'),
  new RegExp(`/product/${ASIN}`, 'i'),
];

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for full Amazon storefront links and `amzn.to`/`a.co` short links. */
export function isAmazonUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return (
    /(^|\.)amazon\./.test(host) ||
    /(^|\.)amzn\.to$/.test(host) ||
    host === 'a.co'
  );
}

/** Pull the ASIN from an Amazon URL, or null if it can't be found (e.g. a
 * short link that only resolves after a redirect we deliberately don't follow). */
export function extractAsin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const queryAsin = parsed.searchParams.get('asin');
  if (queryAsin && /^[A-Z0-9]{10}$/i.test(queryAsin)) {
    return queryAsin.toUpperCase();
  }

  for (const pattern of ASIN_PATH_PATTERNS) {
    const match = parsed.pathname.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

export interface AmazonLink {
  /** A clean canonical link when an ASIN was found, else the original URL. */
  href: string;
  asin: string | null;
}

/**
 * Resolve a pasted Amazon URL into the bits the UI needs: the ASIN (when
 * present) and a tidy `https://<host>/dp/<asin>` link with tracking/ref junk
 * stripped. Non-Amazon or unparseable links pass through unchanged.
 */
export function parseAmazonLink(raw: string): AmazonLink {
  const href = raw.trim();
  const asin = extractAsin(href);
  if (asin) {
    const host = hostnameOf(href);
    if (host) return { href: `https://${host}/dp/${asin}`, asin };
  }
  return { href, asin };
}
