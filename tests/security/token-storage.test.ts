import { describe, expect, it } from 'vitest';
import { SessionTokenManager } from '../../src/session/token.js';

describe('security properties', () => {
  it('hashes tokens one-way instead of returning the token', () => {
    const manager = new SessionTokenManager();
    const { token } = manager.generate();
    const hash = manager.hash(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
  });
});
