import { describe, expect, it } from 'vitest';
import { SessionTokenManager } from '../../src/session/token.js';

describe('SessionTokenManager', () => {
  it('generates at least 256 bits of secret entropy', () => {
    const manager = new SessionTokenManager();
    const first = manager.generate();
    const second = manager.generate();
    expect(first.token).not.toBe(second.token);
    expect(first.token.split('.')[1]!.length).toBeGreaterThanOrEqual(43);
    expect(manager.validateFormat(first.token)).toBe(true);
    expect(manager.hash(first.token)).not.toBe(manager.hash(second.token));
  });

  it('rejects malformed tokens', () => {
    const manager = new SessionTokenManager();
    expect(manager.validateFormat('abc')).toBe(false);
    expect(() => manager.hash('abc')).toThrow();
  });
});
