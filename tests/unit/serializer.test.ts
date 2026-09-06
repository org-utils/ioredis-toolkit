import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SessionSerializer } from '../../src/session/serializer.js';
import type { SessionRecord } from '../../src/session/types.js';

const session: SessionRecord = {
  id: 'a'.repeat(64), jti: 'jti', userId: 'user', createdAt: 100, lastAccessedAt: 100,
  expiresAt: 200, idleExpiresAt: 150, absoluteExpiresAt: 200, status: 'active', version: 1, securityVersion: null
};

describe('SessionSerializer', () => {
  it('round-trips versioned plain sessions', () => {
    const serializer = new SessionSerializer();
    expect(serializer.deserialize(serializer.serialize(session))).toEqual(session);
  });
  it('round-trips AES-256-GCM sessions and rejects tampering', () => {
    const key = randomBytes(32);
    const serializer = new SessionSerializer({ current: () => ({ version: '1', key }), get: v => v === '1' ? key : undefined });
    const encoded = serializer.serialize(session);
    expect(serializer.deserialize(encoded)).toEqual(session);
    const tampered = encoded.slice(0, -1) + (encoded.endsWith('0') ? '1' : '0');
    expect(() => serializer.deserialize(tampered)).toThrow();
  });
});
