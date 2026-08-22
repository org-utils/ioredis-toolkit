import { describe, expect, it } from 'vitest';
import { calculateRedisClusterSlot, hashTag } from '../src/cluster-slot.js';

describe('Redis Cluster hash slots', () => {
  it('uses the canonical CRC16/XMODEM algorithm', () => {
    expect(calculateRedisClusterSlot('123456789')).toBe(12739);
  });

  it('honors hash tags', () => {
    expect(hashTag('{user:42}:profile')).toBe('user:42');
    expect(calculateRedisClusterSlot('{user:42}:profile'))
      .toBe(calculateRedisClusterSlot('{user:42}:orders'));
  });

  it('does not treat empty hash tags as tags', () => {
    expect(hashTag('{}:value')).toBe('{}:value');
  });
});
