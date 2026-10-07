import { describe, expect, it } from 'vitest';
import { createRedisClient, SessionInvalidError } from '../../src/index.js';

const jti = 'a'.repeat(22);
const secret = 'b'.repeat(43);

describe('malformed credentials', () => {
  it.each([
    ['that is empty', ''],
    ['that is too short', 'abc'],
    ['with no separator', `${jti}${secret}`],
    ['with two separators', `${jti}.${secret}.${secret}`],
    ['with a character outside base64url', `${jti}.${secret}!`],
    ['over the length limit', `${jti}.${'b'.repeat(512)}`],
  ])('fails closed on a credential %s', async (_shape, token) => {
    const { sessions } = createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, sessions: { enabled: true } });
    expect(await sessions.validate(token)).toEqual({ valid: false, reason: 'invalid' });
    await expect(sessions.get(token)).rejects.toThrow(SessionInvalidError);
  });
});
