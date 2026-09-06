/** Normalized configuration for {@link RedisPubSub}. */
export interface PubSubConfig {
  /** Whether the application has enabled the module. The class remains directly constructible when false; {@link RedisClient}'s `pubsub` getter throws when disabled. */
  enabled: boolean;
  /** Prefix used for physical Redis channel names. */
  channelPrefix: string;
  /** Maximum UTF-8 encoded JSON message size. */
  maxMessageBytes: number;
}

/** Handle returned by a Pub/Sub subscription. */
export interface Subscription {
  /** Logical, unprefixed channel name. */
  readonly channel: string;
  /** Removes this subscription and unsubscribes the physical channel when no handlers remain. */
  unsubscribe(): Promise<void>;
}

/** Decoded Pub/Sub message delivered to a subscriber callback. */
export interface PubSubMessage<T = unknown> {
  /** Logical, unprefixed channel name. */
  channel: string;
  /** Application payload decoded from JSON. */
  value: T;
}
