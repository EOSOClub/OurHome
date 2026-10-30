import { describe, expect, it } from 'vitest';
import { base64Of, fitWithin, PHOTO_MAX_EDGE } from '@/lib/taskPhoto';

describe('fitWithin', () => {
  it('leaves a small photo alone', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('scales a landscape photo to the long edge', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: PHOTO_MAX_EDGE, height: 1200 });
  });

  it('scales a portrait photo to the long edge', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: PHOTO_MAX_EDGE });
  });

  it('never scales up and keeps at least one pixel', () => {
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
    expect(fitWithin(100000, 10)).toEqual({ width: PHOTO_MAX_EDGE, height: 1 });
  });
});

describe('base64Of', () => {
  it('drops the data: prefix', () => {
    expect(base64Of('data:image/jpeg;base64,/9j/AA==')).toBe('/9j/AA==');
    expect(base64Of('/9j/AA==')).toBe('/9j/AA==');
  });
});
