/**
 * The Redis Cluster key-slot rule, stated from the specification: CRC16/XMODEM of
 * the first non-empty hash tag, or of the whole key when there is none, modulo
 * 16384. A standalone server refuses `CLUSTER KEYSLOT`, so tests compute it here.
 */
export function hashSlot(key: string): number {
  const open = key.indexOf('{');
  const close = open === -1 ? -1 : key.indexOf('}', open + 1);
  let crc = 0;
  for (const byte of Buffer.from(close > open + 1 ? key.slice(open + 1, close) : key)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc % 16_384;
}
