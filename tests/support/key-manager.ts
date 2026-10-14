import { randomBytes } from 'node:crypto';
import type { KeyManager } from '../../src/index.js';

/** A key manager holding one fresh AES-256 key as version 1. */
export function keyManager(): KeyManager {
  return keyManagerHolding({ 1: randomBytes(32) }, '1');
}

/** A key manager holding exactly the given keys by version, encrypting with `current`. */
export function keyManagerHolding(keys: Record<string, Buffer>, current: string): KeyManager {
  return { current: () => ({ version: current, key: keys[current]! }), get: version => keys[version] };
}
