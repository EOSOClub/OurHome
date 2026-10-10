import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '@/server/security/secrets';

const secret = 'test-secret-0123456789';

describe('stored secrets', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('tok_abc123', secret), secret)).toBe('tok_abc123');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret('same', secret)).not.toBe(encryptSecret('same', secret));
  });

  it('refuses another key or a tampered value', () => {
    const stored = encryptSecret('tok_abc123', secret);
    expect(decryptSecret(stored, 'other-secret')).toBeNull();
    const [v, iv, tag, data] = stored.split(':');
    const flipped = data.slice(0, -2) + (data.endsWith('AA') ? 'BB' : 'AA');
    expect(decryptSecret([v, iv, tag, flipped].join(':'), secret)).toBeNull();
    expect(decryptSecret('garbage', secret)).toBeNull();
  });

  it('never stores the plain value', () => {
    expect(encryptSecret('tok_abc123', secret)).not.toContain('tok_abc123');
  });
});
