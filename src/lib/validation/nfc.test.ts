import { describe, expect, it } from 'vitest';
import { nfcAppScanSchema, nfcSetupSchema, registerNfcTagSchema, tagIdSchema } from '@/lib/validation/nfc';

const itemId = 'cmabcdefghijklmnopqrstuvw';
const roomId = 'cmzyxwvutsrqponmlkjihgfed';

describe('tagIdSchema', () => {
  it('accepts HA tag UUIDs and the app\'s hardware-uid ids', () => {
    expect(tagIdSchema.safeParse('cb1a7141-4cac-4b26-aa1d-4262bd962b87').success).toBe(true);
    expect(tagIdSchema.safeParse('uid:04a1b2c3d4e5f6').success).toBe(true);
  });

  it('rejects ids that would not round-trip through a URL', () => {
    expect(tagIdSchema.safeParse('has space').success).toBe(false);
    expect(tagIdSchema.safeParse('a/b').success).toBe(false);
  });
});

describe('nfcAppScanSchema', () => {
  it('rejects a zero amount', () => {
    expect(nfcAppScanSchema.safeParse({ tagId: 'uid:01', amount: 0 }).success).toBe(false);
    expect(nfcAppScanSchema.safeParse({ tagId: 'uid:01', amount: -0.5 }).success).toBe(true);
  });
});

describe('nfcSetupSchema', () => {
  const tagId = 'uid:04a1b2c3';

  it('binds to an existing item or creates a new one', () => {
    expect(nfcSetupSchema.safeParse({ tagId, itemId }).success).toBe(true);
    expect(
      nfcSetupSchema.safeParse({ tagId, newItem: { name: 'Coffee beans', quantity: 2 } }).success,
    ).toBe(true);
  });

  it('makes a location tag for a room', () => {
    expect(nfcSetupSchema.safeParse({ tagId, roomId }).success).toBe(true);
  });

  it('needs exactly one of itemId / newItem / roomId', () => {
    expect(nfcSetupSchema.safeParse({ tagId }).success).toBe(false);
    expect(
      nfcSetupSchema.safeParse({ tagId, itemId, newItem: { name: 'Coffee beans' } }).success,
    ).toBe(false);
    expect(nfcSetupSchema.safeParse({ tagId, itemId, roomId }).success).toBe(false);
  });
});

describe('registerNfcTagSchema', () => {
  const base = { tagId: 'garage_door', label: 'Garage' };

  it('binds a location tag to a room and any other tag to an item', () => {
    expect(registerNfcTagSchema.safeParse({ ...base, represents: 'location', roomId }).success).toBe(true);
    expect(registerNfcTagSchema.safeParse({ ...base, represents: 'consumable', itemId }).success).toBe(true);
    // Represents defaults to consumable, which needs an item.
    expect(registerNfcTagSchema.safeParse({ ...base, itemId }).success).toBe(true);
  });

  it('refuses a location tag without a room, or another tag without an item', () => {
    expect(registerNfcTagSchema.safeParse({ ...base, represents: 'location', itemId }).success).toBe(false);
    expect(registerNfcTagSchema.safeParse({ ...base, represents: 'action', roomId }).success).toBe(false);
  });
});
