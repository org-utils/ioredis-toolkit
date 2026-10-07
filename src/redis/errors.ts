/** Base of every error this package throws. `code` is stable and machine-readable: branch on it, never on the message. */
export class RedisToolkitError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'RedisToolkitError'; }
}

/** Thrown when Redis connection configuration is invalid, or a module is used while disabled. */
export class RedisConfigurationError extends RedisToolkitError {
  declare readonly code: 'REDIS_CONFIGURATION';
  constructor(message: string, options?: ErrorOptions) { super('REDIS_CONFIGURATION', message, options); this.name = 'RedisConfigurationError'; }
}
