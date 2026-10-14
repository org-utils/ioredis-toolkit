import { RedisClientWrapper, createRedisConnection, parseRedisConnectionConfig, type RedisConfig } from '../redis/index.js';
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

/** Dependencies and configuration required to construct a session manager. */
export interface CreateSessionManagerOptions { redis: RedisClientWrapper; config: SessionConfig; encryptionKeyManager?: KeyManager; metrics?: SessionMetrics; }

/** Throws unless a session manager can be built from `config`: sessions are enabled, and encryption has a key manager if it is on. */
function assertBuildable(config: SessionConfig, encryptionKeyManager: KeyManager | undefined): void {
  if (!config.enabled) throw new SessionConfigurationError('Sessions are disabled');
  if (config.encryption.enabled && !encryptionKeyManager) throw new SessionConfigurationError('Encryption is enabled but no key manager was supplied');
}

/** Creates the session subsystem on top of an already-created shared Redis client. */
export function createSessionManager(options: CreateSessionManagerOptions): SessionManager {
  assertBuildable(options.config, options.encryptionKeyManager);
  const keys = new SessionKeyStrategy(options.config.namespace);
  const serializer = new SessionSerializer(options.config.encryption.enabled ? options.encryptionKeyManager : undefined);
  const scripts = new SessionScriptRegistry(options.redis);
  const repository = new SessionRepository({ redis: options.redis, keys, serializer, scripts, config: options.config });
  return new SessionManager(new SessionService({ repository, tokens: new SessionTokenManager(options.config.tokenBytes), redis: options.redis, config: options.config, ...(options.metrics ? { metrics: options.metrics } : {}) }));
}

/**
 * Creates a session manager and shared Redis wrapper from separate configuration objects. Both are validated before
 * anything connects, so a mistyped `mode`, disabled sessions or encryption without a key manager leave no connection behind.
 */
export function createSessionManagerFromRedis(redisConfig: RedisConfig, sessionConfig: unknown): { manager: SessionManager; redis: RedisClientWrapper; config: SessionConfig } {
  parseRedisConnectionConfig(redisConfig);
  const config = parseSessionConfig(sessionConfig);
  // This entry point takes no key manager, so a configuration with encryption on is refused here.
  assertBuildable(config, undefined);
  const redis = new RedisClientWrapper(createRedisConnection(redisConfig));
  return { manager: createSessionManager({ redis, config }), redis, config };
}
