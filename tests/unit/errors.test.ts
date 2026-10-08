import { describe, it } from 'vitest';
import {
  CacheError, LockError, PubSubError, RateLimitError, RedisConfigurationError, StreamsError,
  SessionConfigurationError, SessionInputError, SessionInvalidError, SessionLimitError, SessionStorageError,
  createRedisClient, parseCacheConfig, parseLockConfig, parsePubSubConfig, parseRateLimitConfig, parseRedisConnectionConfig,
  parseSessionConfig, parseStreamsConfig, serializeCookie,
} from '../../src/index.js';
import type { RedisClientConfig } from '../../src/index.js';
import { closedPort } from '../support/closed-port.js';
import { unknownCredential } from '../support/credential.js';
import { expectPackageError } from '../support/errors.js';

type ModuleSections = Pick<RedisClientConfig, 'cache' | 'lock' | 'rateLimit' | 'pubsub' | 'streams' | 'sessions'>;

/** A client facade that never connects; these failures are all decided before a command is sent. */
function offlineClient(modules: ModuleSections = {}) {
  return createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: 6379, lazyConnect: true, ...modules });
}

/** A client facade whose Redis cannot be reached. */
async function unreachableClient(modules: ModuleSections = {}) {
  return createRedisClient({ mode: 'standalone', host: '127.0.0.1', port: await closedPort(), lazyConnect: true, retryStrategy: () => null, ...modules });
}

// The codes that need a real server are asserted in tests/integration.
describe('error codes', () => {
  it.each([
    { code: 'REDIS_CONFIGURATION', type: RedisConfigurationError, condition: 'an invalid connection configuration', operation: () => parseRedisConnectionConfig({ port: 0 }) },
    { code: 'REDIS_CONFIGURATION', type: RedisConfigurationError, condition: 'a module used while disabled', operation: () => offlineClient().cache },

    { code: 'SESSION_CONFIGURATION', type: SessionConfigurationError, condition: 'an invalid session configuration', operation: () => parseSessionConfig({ ttl: 0 }) },
    { code: 'SESSION_CONFIGURATION', type: SessionConfigurationError, condition: 'sessions used while disabled', operation: () => offlineClient().sessions },
    { code: 'SESSION_INVALID', type: SessionInvalidError, condition: 'a malformed credential', operation: () => offlineClient({ sessions: { enabled: true } }).sessions.get('abc') },
    { code: 'SESSION_LIMIT', type: SessionLimitError, condition: 'a page larger than maxBatchSize', operation: () => offlineClient({ sessions: { enabled: true, maxBatchSize: 10 } }).sessions.list('user', 0, 11) },
    { code: 'SESSION_STORAGE', type: SessionStorageError, condition: 'a session read while Redis is unreachable', operation: async () => (await unreachableClient({ sessions: { enabled: true } })).sessions.get(unknownCredential) },
    { code: 'SESSION_INPUT', type: SessionInputError, condition: 'a cookie name that is not a valid token', operation: () => serializeCookie('value', { name: 'not a token' }) },

    { code: 'CACHE_CONFIGURATION', type: CacheError, condition: 'an invalid cache configuration', operation: () => parseCacheConfig({ defaultTtl: 0 }) },
    { code: 'CACHE_INPUT', type: CacheError, condition: 'a cache write asking for both nx and xx', operation: () => offlineClient({ cache: { enabled: true } }).cache.set('key', 1, { nx: true, xx: true }) },
    { code: 'CACHE_SERIALIZATION', type: CacheError, condition: 'a cache value JSON cannot represent', operation: () => offlineClient({ cache: { enabled: true } }).cache.set('key', undefined) },
    { code: 'CACHE_SERIALIZATION', type: CacheError, condition: 'a cache value JSON.stringify throws on', operation: () => offlineClient({ cache: { enabled: true } }).cache.set('key', { id: 1n }) },
    { code: 'CACHE_LIMIT', type: CacheError, condition: 'a cache value larger than maxValueBytes', operation: () => offlineClient({ cache: { enabled: true, maxValueBytes: 4 } }).cache.set('key', { id: 1 }) },

    { code: 'LOCK_CONFIGURATION', type: LockError, condition: 'an invalid lock configuration', operation: () => parseLockConfig({ defaultTtl: 500, maxTtl: 300 }) },
    { code: 'LOCK_INPUT', type: LockError, condition: 'a lock TTL that is not positive', operation: () => offlineClient({ lock: { enabled: true } }).lock.acquire('name', 0) },
    { code: 'LOCK_LIMIT', type: LockError, condition: 'a lock TTL longer than maxTtl', operation: () => offlineClient({ lock: { enabled: true, maxTtl: 300 } }).lock.acquire('name', 301) },

    { code: 'RATE_LIMIT_CONFIGURATION', type: RateLimitError, condition: 'an invalid rate-limit configuration', operation: () => parseRateLimitConfig({ windowSeconds: 0 }) },
    { code: 'RATE_LIMIT_INPUT', type: RateLimitError, condition: 'a rate-limit cost that is not a positive integer', operation: () => offlineClient({ rateLimit: { enabled: true } }).rateLimiter.consume('subject', 0) },

    { code: 'PUBSUB_CONFIGURATION', type: PubSubError, condition: 'an invalid Pub/Sub configuration', operation: () => parsePubSubConfig({ maxMessageBytes: 0 }) },
    { code: 'PUBSUB_SERIALIZATION', type: PubSubError, condition: 'a published value JSON cannot represent', operation: () => offlineClient({ pubsub: { enabled: true } }).pubsub.publish('channel', undefined) },
    { code: 'PUBSUB_SERIALIZATION', type: PubSubError, condition: 'a published value JSON.stringify throws on', operation: () => offlineClient({ pubsub: { enabled: true } }).pubsub.publish('channel', { id: 1n }) },
    { code: 'PUBSUB_LIMIT', type: PubSubError, condition: 'a published message larger than maxMessageBytes', operation: () => offlineClient({ pubsub: { enabled: true, maxMessageBytes: 4 } }).pubsub.publish('channel', { id: 1 }) },

    { code: 'STREAMS_CONFIGURATION', type: StreamsError, condition: 'an invalid Streams configuration', operation: () => parseStreamsConfig({ maxEntries: 0 }) },
    { code: 'STREAMS_INPUT', type: StreamsError, condition: 'a consumer-group read that names no consumer', operation: () => offlineClient({ streams: { enabled: true } }).streams.read('stream', { group: 'group' }) },
  ])('reports $code for $condition', async ({ code, type, operation }) => {
    await expectPackageError(operation, type, code);
  });
});
