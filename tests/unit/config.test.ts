import { describe, expect, it } from 'vitest';
import { parseSessionConfig } from '../../src/session/config.js';
import { parseLockConfig } from '../../src/lock/config.js';

describe('Session configuration', () => {
  it('defaults to disabled', () => {
    expect(parseSessionConfig({}).enabled).toBe(false);
  });
  it('rejects insecure SameSite=None', () => {
    expect(() => parseSessionConfig({ cookie: { sameSite: 'none', secure: false } })).toThrow();
  });
  it('rejects idle timeout greater than absolute timeout', () => {
    expect(() => parseSessionConfig({ idleTimeout: 20, absoluteTimeout: 10 })).toThrow();
  });
  it('defaults circuitBreaker when omitted entirely', () => {
    const config = parseSessionConfig({ enabled: true });
    expect(config.circuitBreaker).toEqual({ enabled: false, failureThreshold: 5, resetTimeoutMs: 10_000, halfOpenMaxRequests: 1 });
  });
});

describe('Lock configuration', () => {
  it('rejects a defaultTtl greater than maxTtl', () => {
    expect(() => parseLockConfig({ defaultTtl: 500, maxTtl: 300 })).toThrow();
  });
});
