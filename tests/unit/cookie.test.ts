import { describe, expect, it } from 'vitest';
import { SessionInputError, createRedisClient, serializeCookie } from '../../src/index.js';
import type { SessionConfig } from '../../src/index.js';
import { expectPackageError } from '../support/errors.js';

describe('cookie serialization', () => {
  // Each would end the attribute early and let the value inject one of its own, or split the header.
  const unsafe = { semicolon: '/; HttpOnly=false', CR: 'a\rb', LF: 'a\nb', NUL: 'a\0b', DEL: 'a\x7fb', space: 'a b', tab: 'a\tb' };

  it.each(Object.entries(unsafe))('rejects a Path carrying a %s', async (_character, path) => {
    await expectPackageError(() => serializeCookie('v', { name: 's', path }), SessionInputError, 'SESSION_INPUT');
  });

  it.each(Object.entries(unsafe))('rejects a Domain carrying a %s', async (_character, domain) => {
    await expectPackageError(() => serializeCookie('v', { name: 's', domain }), SessionInputError, 'SESSION_INPUT');
  });

  it('writes a Domain and Path that carry none of them', () => {
    expect(serializeCookie('v', { name: 's', domain: 'example.com', path: '/app' })).toBe('s=v; Domain=example.com; Path=/app; HttpOnly; Secure');
  });
});

describe('session manager cookies', () => {
  /** A session manager that never connects: neither cookie below needs the server. */
  function sessionsWith(cookie: Partial<SessionConfig['cookie']>) {
    return createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, sessions: { enabled: true, cookie: { name: 'sid', path: '/app', domain: 'example.com', ...cookie } } }).sessions;
  }

  it('expires the configured cookie', () => {
    expect(sessionsWith({ sameSite: 'strict' }).deletionCookie())
      .toBe('sid=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.com; Path=/app; HttpOnly; Secure; SameSite=Strict');
  });

  it('gives a session cookie the configured Max-Age when there is one', async () => {
    const sessions = sessionsWith({ maxAge: 900 });
    const session = { expiresAt: 0 } as Parameters<typeof sessions.cookie>[1];
    expect(await sessions.cookie('token', session)).toBe('sid=token; Max-Age=900; Domain=example.com; Path=/app; HttpOnly; Secure; SameSite=Lax');
  });
});
