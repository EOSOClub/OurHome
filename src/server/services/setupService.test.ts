import { describe, expect, it, vi } from 'vitest';

// The message builder needs no database; stub the modules that would open one.
vi.mock('@/server/db/prisma', () => ({ prisma: {} }));
vi.mock('@/server/auth/auth', () => ({ auth: {} }));

const { setupRequiredMessage } = await import('./setupService');

describe('setupRequiredMessage', () => {
  it('points at the address the client used', () => {
    const msg = setupRequiredMessage(new Headers({ host: '192.168.1.20:3000' }));
    expect(msg).toContain('http://192.168.1.20:3000');
    expect(msg).toMatch(/then try again/);
  });

  it('keeps https when the request came through a tunnel', () => {
    const msg = setupRequiredMessage(
      new Headers({ host: 'home.example.com', 'x-forwarded-proto': 'https' }),
    );
    expect(msg).toContain('https://home.example.com');
  });

  it('still reads well without a Host header', () => {
    expect(setupRequiredMessage(new Headers())).toContain('this server’s address');
  });
});
