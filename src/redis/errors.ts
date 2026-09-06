/** Thrown when Redis connection configuration is invalid, or a module is used while disabled. */
export class RedisConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RedisConfigurationError'; }
}
