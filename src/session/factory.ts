import type { RedisClientWrapper } from '../redis/wrapper.js';
import { createRedisConnection } from '../redis/client.js';
import type { RedisConfig } from '../redis/types.js';
import { parseSessionConfig, type SessionConfig } from './config.js';
import { SessionKeyStrategy } from './keys.js';
import { SessionSerializer } from './serializer.js';
import { SessionScriptRegistry } from './scripts.js';
import { SessionRepository } from './repository.js';
import { SessionService } from './service.js';
import { SessionManager } from './manager.js';
import { SessionTokenManager } from './token.js';
import type { KeyManager, SessionMetrics } from './types.js';
import { SessionConfigurationError } from './errors.js';
import { RedisClientWrapper as Wrapper } from '../redis/wrapper.js';

/** Dependencies and configuration required to construct a session manager. */
export interface CreateSessionManagerOptions { redis: RedisClientWrapper; config: SessionConfig; encryptionKeyManager?: KeyManager; metrics?: SessionMetrics; }

/** Creates the session subsystem on top of an already-created shared Redis client. */
export function createSessionManager(options: CreateSessionManagerOptions): SessionManager {
  if (!options.config.enabled) throw new SessionConfigurationError('Sessions are disabled');
  const keys = new SessionKeyStrategy(options.config.namespace);
  if (options.config.encryption.enabled && !options.encryptionKeyManager) throw new SessionConfigurationError('Encryption is enabled but no key manager was supplied');
  const serializer = new SessionSerializer(options.config.encryption.enabled ? options.encryptionKeyManager : undefined);
  const scripts = new SessionScriptRegistry(options.redis);
  const repository = new SessionRepository({ redis: options.redis, keys, serializer, scripts, config: options.config });
  return new SessionManager(new SessionService({ repository, tokens: new SessionTokenManager(options.config.tokenBytes), redis: options.redis, config: options.config, ...(options.metrics ? { metrics: options.metrics } : {}) }));
}

/** Creates a session manager and shared Redis wrapper from separate configuration objects. */
export function createSessionManagerFromRedis(redisConfig: RedisConfig, sessionConfig: unknown): { manager: SessionManager; redis: RedisClientWrapper; config: SessionConfig } {
  const config = parseSessionConfig(sessionConfig);
  const redis = new Wrapper(createRedisConnection(redisConfig));
  return { manager: createSessionManager({ redis, config }), redis, config };
}
