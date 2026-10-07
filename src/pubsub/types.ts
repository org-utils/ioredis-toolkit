import type { ModuleConfigBase } from '../redis/config-base.js';

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
