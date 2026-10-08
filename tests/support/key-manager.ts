import { randomBytes } from 'node:crypto';
import type { KeyManager } from '../../src/index.js';

/** A key manager holding one fresh AES-256 key as version 1. */
export function keyManager(): KeyManager {
  const key = randomBytes(32);
  return { current: () => ({ version: '1', key }), get: version => (version === '1' ? key : undefined) };
}
