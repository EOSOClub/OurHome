import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  enabledFeatures,
  featureForPath,
  hiddenSubjectTypes,
  maskAccess,
} from '@/lib/features';
import { FULL_ACCESS } from '@/lib/permissions';

describe('enabledFeatures', () => {
  it('has everything on when nothing is stored', () => {
    expect(enabledFeatures(undefined)).toEqual([...FEATURES]);
    expect(enabledFeatures([])).toEqual([...FEATURES]);
  });

  it('drops the turned-off ones and ignores unknown names', () => {
    expect(enabledFeatures(['shopping', 'bills', 'nonsense'])).toEqual([
      'tasks',
      'points',
      'calendar',
      'inventory',
      'requests',
    ]);
  });

  it('turns Points off with Tasks', () => {
    expect(enabledFeatures(['tasks'])).not.toContain('points');
  });
});

describe('featureForPath', () => {
  it('maps pages and API routes alike', () => {
    expect(featureForPath('/tasks')).toBe('tasks');
    expect(featureForPath('/api/subtasks/toggle')).toBe('tasks');
    expect(featureForPath('/api/nfc/scan')).toBe('inventory');
    expect(featureForPath('/bills/abc')).toBe('bills');
    expect(featureForPath('/api/points/summary')).toBe('points');
    expect(featureForPath('/api/integrations/paperless/sync')).toBe('bills');
  });

  it('leaves always-on areas alone', () => {
    for (const p of ['/dashboard', '/api/dashboard', '/api/activity', '/api/permissions/me', '/', '/api/server/households', '/api/integrations']) {
      expect(featureForPath(p)).toBeNull();
    }
  });
});

describe('maskAccess', () => {
  it('empties the pages of turned-off features only', () => {
    const masked = maskAccess(FULL_ACCESS, enabledFeatures(['shopping']));
    expect(Object.values(masked.shopping).some(Boolean)).toBe(false);
    expect(Object.values(masked.shoppingLists).some(Boolean)).toBe(false);
    expect(masked.tasks).toEqual(FULL_ACCESS.tasks);
    expect(FULL_ACCESS.shopping.create).toBe(true); // input untouched
  });
});

describe('hiddenSubjectTypes', () => {
  it('lists the notification subjects of turned-off features', () => {
    expect(hiddenSubjectTypes(enabledFeatures([]))).toEqual([]);
    expect(hiddenSubjectTypes(enabledFeatures(['inventory'])).sort()).toEqual(['inventory_item', 'nfc_tag']);
  });
});
