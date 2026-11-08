import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail, placeholderEmailFor } from '@/lib/placeholderEmail';

describe('placeholder emails', () => {
  it('makes the stand-in address members without an email get', () => {
    expect(placeholderEmailFor('sam')).toBe('sam@household.local');
    expect(placeholderEmailFor('Sam')).toBe('sam@household.local');
  });

  it('recognises stand-in addresses, whatever their case or spacing', () => {
    expect(isPlaceholderEmail('sam@household.local')).toBe(true);
    expect(isPlaceholderEmail(' Sam@Household.Local ')).toBe(true);
    expect(isPlaceholderEmail(placeholderEmailFor('pat'))).toBe(true);
  });

  it('leaves real addresses alone', () => {
    expect(isPlaceholderEmail('pat@example.com')).toBe(false);
    expect(isPlaceholderEmail('pat@myhousehold.local.example.com')).toBe(false);
    expect(isPlaceholderEmail('pat@notahousehold.local')).toBe(false);
    expect(isPlaceholderEmail('')).toBe(false);
    expect(isPlaceholderEmail(null)).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
  });
});
