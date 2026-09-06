import { createHash } from 'node:crypto';

const SLOT_COUNT = 16_384;

const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 8;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

function hashInput(key: string): Buffer {
  const first = key.indexOf('{');
  if (first !== -1) {
    const second = key.indexOf('}', first + 1);
    if (second !== -1 && second > first + 1) return Buffer.from(key.slice(first + 1, second));
  }
  return Buffer.from(key);
}

/** Calculates the Redis Cluster hash slot (0-16383), honoring the first valid hash tag. */
export function redisHashSlot(key: string): number {
  const input = hashInput(key);
  let crc = 0;
  for (const byte of input) { const index = ((crc >>> 8) ^ byte) & 0xff; crc = ((crc << 8) ^ CRC16_TABLE[index]!) & 0xffff; }
  return crc % SLOT_COUNT;
}

/** Derives a fixed-length SHA-256 user tag safe for Redis Cluster hash-tagging. */
export function safeUserTag(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

/** Throws when two or more keys do not resolve to the same Redis Cluster slot. */
export function assertSameSlot(keys: readonly string[]): void {
  if (keys.length < 2) return;
  const slot = redisHashSlot(keys[0]!);
  for (const key of keys.slice(1)) {
    if (redisHashSlot(key) !== slot) throw new Error('Redis keys do not share a hash slot');
  }
}
