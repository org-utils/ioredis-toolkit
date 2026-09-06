import { describe, expect, it } from 'vitest';
import { assertSameSlot, redisHashSlot, safeUserTag } from '../../src/redis/cluster.js';

describe('Redis Cluster hashing', () => {
  it('implements Redis hash tags', () => {
    expect(redisHashSlot('a{user}:1')).toBe(redisHashSlot('b{user}:2'));
    expect(redisHashSlot('a{user}:1')).not.toBe(redisHashSlot('a{other}:1'));
  });
  it('produces safe deterministic user tags', () => {
    const tag = safeUserTag('user:{malicious}');
    expect(tag).toMatch(/^[a-f0-9]{64}$/);
    expect(safeUserTag('same')).toBe(safeUserTag('same'));
  });
  it('detects same-slot key sets', () => {
    expect(() => assertSameSlot(['x{u}', 'y{u}'])).not.toThrow();
    expect(() => assertSameSlot(['x{u}', 'y{v}'])).toThrow();
  });
});
