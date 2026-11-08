import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safeRedirect';

describe('safeRedirect', () => {
  it('follows same-origin paths', () => {
    expect(safeRedirect('/setup/members')).toBe('/setup/members');
    expect(safeRedirect('/tasks?filter=mine')).toBe('/tasks?filter=mine');
  });

  it('falls back to the dashboard when there is no target', () => {
    expect(safeRedirect(undefined)).toBe('/dashboard');
    expect(safeRedirect(null)).toBe('/dashboard');
    expect(safeRedirect('')).toBe('/dashboard');
  });

  it('refuses other sites', () => {
    expect(safeRedirect('https://evil.example/login')).toBe('/dashboard');
    expect(safeRedirect('//evil.example')).toBe('/dashboard');
    expect(safeRedirect('/\\evil.example')).toBe('/dashboard');
    expect(safeRedirect('/\t/evil.example')).toBe('/dashboard');
    expect(safeRedirect('javascript:alert(1)')).toBe('/dashboard');
  });
});
