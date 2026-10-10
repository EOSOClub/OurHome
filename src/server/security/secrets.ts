import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Encrypts credentials the app stores for a household (e.g. its Paperless API
// token) so a database dump alone doesn't hand them out. AES-256-GCM with a
// key derived from BETTER_AUTH_SECRET (already a required secret) and a
// purpose label. Changing that secret makes stored values unreadable: they
// then have to be entered again (the callers say so).

const VERSION = 'v1';

function key(secret = process.env.BETTER_AUTH_SECRET): Buffer {
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set; can’t encrypt stored credentials.');
  return createHash('sha256').update(`ourhome:stored-secrets:${VERSION}:${secret}`).digest();
}

/** "v1:<iv>:<tag>:<ciphertext>", all base64url. */
export function encryptSecret(plain: string, secret?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

/** The plain value, or null when it can't be read (other secret, tampered). */
export function decryptSecret(stored: string, secret?: string): string | null {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
