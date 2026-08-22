/** Redis Cluster uses CRC16-CCITT/XMODEM over the hash-tagged key bytes. */
const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0
        ? ((crc << 1) ^ 0x1021) & 0xffff
        : (crc << 1) & 0xffff;
    }
    table[i] = crc;
  }
  return table;
})();

/** Extracts the Redis Cluster hash tag from a key. */
export function hashTag(key: string): string {
  const start = key.indexOf("{");
  if (start < 0) return key;
  const end = key.indexOf("}", start + 1);
  return end > start + 1 ? key.slice(start + 1, end) : key;
}

/** Returns the Redis Cluster hash slot for a key (0..16383). */
export function calculateRedisClusterSlot(key: string): number {
  const bytes = Buffer.from(hashTag(key), "utf8");
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >>> 8) ^ byte) & 0xff]!) & 0xffff;
  }
  return crc % 16384;
}
