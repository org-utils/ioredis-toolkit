import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportsOf, manifest, packageProgram, sourceOf, specifiers } from '../support/exports-map.js';

/** The names one importable path hands a consumer: `values` exist at runtime, `types` only in an annotation. */
interface Surface { values: string[]; types: string[]; }

/**
 * The public surface (ADR-0003) of each subpath, written out by hand. A name added to an entry point or
 * to the root barrel fails this suite until it is added here as well, which is what makes widening the
 * public surface a deliberate act; a name ADR-0003 places internal has no line to go on.
 */
const subpathSurfaces: Record<string, Surface> = {
  'ioredis-toolkit/session': {
    values: [
      'SessionManager', 'createSessionManager', 'createSessionManagerFromRedis', 'parseSessionConfig', 'serializeCookie', 'serializeDeletionCookie',
      'SessionError', 'SessionNotFoundError', 'SessionExpiredError', 'SessionRevokedError', 'SessionInvalidError',
      'SessionReplayError', 'SessionRotationError', 'SessionConflictError', 'SessionStorageError',
      'SessionSerializationError', 'SessionConfigurationError', 'SessionInputError', 'SessionLimitError',
    ],
    types: [
      'CreateSessionManagerOptions', 'SessionConfig', 'CookieOptions', 'SessionErrorCode',
      'SessionRecord', 'SessionStatus', 'CreateSessionInput', 'CreatedSession', 'ValidationResult', 'InvalidReason',
      'RotationResult', 'SessionPatch', 'SessionMetrics', 'KeyManager', 'RedisConfig',
    ],
  },
  'ioredis-toolkit/cache': {
    values: ['RedisCache', 'parseCacheConfig', 'CacheError'],
    types: ['CacheConfig', 'CacheSetOptions', 'CacheResult', 'CacheErrorCode'],
  },
  'ioredis-toolkit/lock': {
    values: ['RedisLock', 'parseLockConfig', 'LockError'],
    types: ['LockConfig', 'LockAcquireResult', 'LockErrorCode'],
  },
  'ioredis-toolkit/rate-limit': {
    values: ['RedisRateLimiter', 'parseRateLimitConfig', 'RateLimitError'],
    types: ['RateLimitConfig', 'RateLimitResult', 'RateLimitErrorCode'],
  },
  'ioredis-toolkit/pubsub': {
    values: ['RedisPubSub', 'parsePubSubConfig', 'PubSubError'],
    types: ['PubSubConfig', 'PubSubMessage', 'Subscription', 'PubSubErrorCode'],
  },
  'ioredis-toolkit/streams': {
    values: ['RedisStreams', 'parseStreamsConfig', 'StreamsError'],
    types: ['StreamsConfig', 'StreamEntry', 'StreamReadOptions', 'StreamsErrorCode'],
  },
};

/** What only the root barrel exports: the client facade, and the part of the kernel a consumer holds. */
const rootOnly: Surface = {
  values: ['createRedisClient', 'RedisClient', 'createRedisConnection', 'parseRedisConnectionConfig', 'RedisToolkitError', 'RedisConfigurationError'],
  types: [
    'RedisClientConfig', 'RedisClientDependencies', 'ModuleConfigMode',
    'RedisConfig', 'RedisMode', 'StandaloneRedisConfig', 'SentinelRedisConfig', 'ClusterRedisConfig',
    'RedisConnection', 'RedisCommandClient', 'RedisPipeline', 'ClusterFanoutOptions', 'ModuleConfigBase',
  ],
};

/** The surface written for a specifier: the root's is what only it exports, together with every subpath's. */
function surfaceOf(specifier: string): Surface | undefined {
  if (specifier !== manifest.name) return subpathSurfaces[specifier];
  const all = [rootOnly, ...Object.values(subpathSurfaces)];
  return { values: all.flatMap(surface => surface.values), types: all.flatMap(surface => surface.types) };
}

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();

describe('public surface', () => {
  let program: ts.Program;

  /** The names importing a specifier yields at runtime. */
  async function runtimeNames(specifier: string): Promise<string[]> {
    return Object.keys(await import(pathToFileURL(sourceOf(specifier)).href) as object);
  }

  beforeAll(() => {
    program = packageProgram(specifiers.map(sourceOf));
  }, 60_000);

  it('a surface is written for every subpath in the exports map, and for nothing else', () => {
    expect(sorted([manifest.name, ...Object.keys(subpathSurfaces)])).toEqual(sorted(specifiers));
  });

  it.each(specifiers)('%s exports exactly the values of its public surface', async specifier => {
    expect(sorted(await runtimeNames(specifier))).toEqual(sorted(surfaceOf(specifier)?.values ?? []));
  });

  it.each(specifiers)('%s exports exactly the types of its public surface', async specifier => {
    const values = new Set(await runtimeNames(specifier));
    const typeOnly = [...exportsOf(program, sourceOf(specifier)).keys()].filter(name => !values.has(name));
    expect(sorted(typeOnly)).toEqual(sorted(surfaceOf(specifier)?.types ?? []));
  });
});
