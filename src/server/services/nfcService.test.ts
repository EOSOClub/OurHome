import { describe, expect, it } from 'vitest';
import { parseTagConfig, parseTagItemId } from '@/server/services/nfcService';

const tag = (config: unknown) => ({ config: config === null ? null : JSON.stringify(config) });

describe('parseTagConfig', () => {
  it('reads legacy configs that only bind an item', () => {
    expect(parseTagConfig(tag({ itemId: 'item1' }))).toEqual({
      itemId: 'item1',
      scanAction: undefined,
      shoppingListId: null,
    });
    expect(parseTagItemId(tag({ itemId: 'item1' }))).toBe('item1');
  });

  it('reads the app scan settings', () => {
    expect(parseTagConfig(tag({ itemId: 'i', scanAction: 'notify', shoppingListId: 'l1' }))).toEqual({
      itemId: 'i',
      scanAction: 'notify',
      shoppingListId: 'l1',
    });
  });

  it('ignores unknown scan actions and bad JSON', () => {
    expect(parseTagConfig(tag({ itemId: 'i', scanAction: 'explode' })).scanAction).toBeUndefined();
    expect(parseTagConfig({ config: '{not json' })).toEqual({});
    expect(parseTagConfig(null)).toEqual({});
  });
});
