import { RedisToolkitError, type ModuleConfigBase } from '../redis/index.js';

/** Stable machine-readable error codes emitted by Pub/Sub. */
export type PubSubErrorCode = 'PUBSUB_CONFIGURATION' | 'PUBSUB_SERIALIZATION' | 'PUBSUB_LIMIT';

/** Thrown when Pub/Sub configuration is invalid, or a published value cannot be encoded to JSON or is over the byte cap. */
export class PubSubError extends RedisToolkitError {
  declare readonly code: PubSubErrorCode;
  constructor(code: PubSubErrorCode, message: string, options?: ErrorOptions) { super(code, message, options); this.name = 'PubSubError'; }
}

/** Normalized configuration for {@link RedisPubSub}. */
export interface PubSubConfig extends ModuleConfigBase {
  /** Maximum UTF-8 encoded JSON message size. */
  maxMessageBytes: number;
}

/** Handle returned by a Pub/Sub subscription. */
export interface Subscription {
  /** Logical channel name, without the namespace. */
  readonly channel: string;
  /** Removes this subscription and unsubscribes the physical channel when no handlers remain. */
  unsubscribe(): Promise<void>;
}

/** Decoded Pub/Sub message delivered to a subscriber callback. */
export interface PubSubMessage<T = unknown> {
  /** Logical channel name, without the namespace. */
  channel: string;
  /** Application payload decoded from JSON. */
  value: T;
}
