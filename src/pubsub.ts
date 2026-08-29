import { RedisClientWrapper } from './client.js';

import { EventEmitter } from 'node:events';
import { RedisConfig } from './types.js';
import { defaultLogger, LoggerLike } from './logger.js';

/**
 * Redis Pub/Sub with a dedicated publisher and subscriber connection.
 *
 * **Description:**
 * Provides a higher-level interface over native Redis Pub/Sub with the following features:
 * - Dedicated publisher connection (configured at construction)
 * - Dedicated subscriber connection (opened via {@link connectSubscriber})
 * - JSON serialization on publish, auto-parsing on delivery
 * - Pattern subscription support (`psubscribe`, `punsubscribe`)
 * - Extends Node.js `EventEmitter` for event-based handling
 * - Emits `'error'` events on subscriber failures
 *
 * **Type Parameters:**
 * - `T` - The type of message payload. When publishing non-string values, they are
 *   JSON-serialized. When subscribing, messages are auto-parsed from JSON when possible.
 *
 * **Mode Support:**
 * - Standalone, Sentinel, and Cluster modes are all supported.
 * - The subscriber connection is created per the configured mode.
 *
 * **Example:**
 * ```ts
 * const pubsub = new PubSub(client);
 * await pubsub.connectSubscriber({ mode: 'standalone', host: 'localhost', port: 6379 });
 *
 * // Subscribe to a channel
 * await pubsub.subscribe('orders:created', (message) => {
 *   console.log(message); // { id: 1 } - JSON-parsed
 * });
 *
 * // Publish a message
 * const receivers = await pubsub.publish('orders:created', { id: 1 });
 * // receivers === number of subscribers that received the message
 *
 * // Pattern subscription
 * await pubsub.psubscribe('orders:*', ({ channel, message }) => {
 *   console.log(channel, message);
 * });
 * ```
 *
 * **Event Emissions:**
 * - `message`: Emitted when a message is received on a subscribed channel.
 *   Payload: `{ channel: string, message: string }`
 * - `pmessage`: Emitted when a pattern message is received.
 *   Payload: `{ pattern: string, channel: string, message: string }`
 * - `error`: Emitted on subscriber errors.
 *   Payload: `Error`
 */
export class PubSub extends EventEmitter {
  private publisher: RedisClientWrapper;
  private subscriber: RedisClientWrapper | null = null;
  private logger: LoggerLike;
  private subscriptions: Map<string, Set<(data: any) => void>> = new Map();
  private patternSubscriptions: Map<string, Set<(data: any) => void>> = new Map();

  /**
   * Creates a pub/sub instance. Publishing works immediately; subscribing
   * requires calling {@link connectSubscriber} first.
   *
   * @param publisher - A {@link RedisClientWrapper} used for publishing.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const pubsub = new PubSub(client);
   * ```
   */
  /**
   * Creates a pub/sub instance. Publishing works immediately; subscribing
   * requires calling {@link connectSubscriber} first.
   *
   * @param publisher - A {@link RedisClientWrapper} used for publishing.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const pubsub = new PubSub(client);
   * ```
   */
  constructor(publisher: RedisClientWrapper, logger: LoggerLike = defaultLogger) {
    super();
    this.publisher = publisher;
    this.logger = logger.child({ component: 'PubSub' });
  }

  /**
   * Opens a dedicated subscriber connection.
   *
   * Idempotent: a second call is a no-op while a subscriber is connected.
   * Subscriber errors are emitted as `'error'` events on the instance.
   *
   * @param config - Redis config for the subscriber connection (any mode).
   *
   * @example
   * ```ts
   * await pubsub.connectSubscriber({ mode: 'standalone', host: 'localhost', port: 6379 });
   * ```
   */
  /**
   * Opens a dedicated subscriber connection.
   *
   * **Behavior:**
   * - Idempotent: a second call is a no-op while a subscriber is connected.
   * - Subscriber errors are emitted as `'error'` events on the instance.
   *
   * **Parameters:**
   * - `config` - Redis config for the subscriber connection (any mode: standalone, sentinel, or cluster).
   *
   * **Example:**
   * ```ts
   * // Connect with standalone configuration
   * await pubsub.connectSubscriber({ mode: 'standalone', host: 'localhost', port: 6379 });
   *
   * // Connect with cluster configuration
   * await pubsub.connectSubscriber({
   *   mode: 'cluster',
   *   clusterNodes: [{ host: 'redis1', port: 7000 }, { host: 'redis2', port: 7001 }],
   * });
   * ```
   *
   * @returns `Promise<void>` that resolves when the subscriber connection is established.
   */
  async connectSubscriber(config: RedisConfig): Promise<void> {
    if (this.subscriber) return;

    this.subscriber = new RedisClientWrapper(config, this.logger);
    this.setupSubscriber();
  }

  /**
   * Sets up event listeners on the subscriber connection.
   *
   * **Behavior:**
   * - Listens for `message` events and dispatches to {@link handleMessage}.
   * - Listens for `pmessage` events (pattern subscriptions) and dispatches to {@link handlePatternMessage}.
   * - Listens for `error` events and emits them on the instance.
   *
   * @internal
   */
  private setupSubscriber(): void {
    if (!this.subscriber) return;

    const raw = this.subscriber.raw;

    raw.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    raw.on('pmessage', (pattern: string, channel: string, message: string) => {
      this.handlePatternMessage(pattern, channel, message);
    });

    raw.on('error', (error) => {
      this.logger.error('Subscriber error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Handles a standard message event from the subscriber.
   *
   * **Behavior:**
   * - Parses the message payload as JSON when possible.
   * - Invokes all registered handlers for the channel.
   * - Catches and logs handler errors without crashing.
   *
   * **Parameters:**
   * - `channel` - The Redis channel name.
   * - `message` - The raw message string from Redis (JSON-encoded).
   *
   * @internal
   */
  private handleMessage(channel: string, message: string): void {
    const handlers = this.subscriptions.get(channel);
    if (!handlers) return;

    let parsed: any = message;
    try { parsed = JSON.parse(message); } catch {}

    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch (error) {
        this.logger.error('Handler error:', error as Record<string, any>);
      }
    }
  }

  /**
   * Handles a pattern message event from the subscriber.
   *
   * **Behavior:**
   * - Parses the message payload as JSON when possible.
   * - Invokes all registered handlers for the pattern.
   * - Each handler receives an object with `channel` and `message` properties.
   * - Catches and logs handler errors without crashing.
   *
   * **Parameters:**
   * - `pattern` - The pattern that matched.
   * - `channel` - The specific channel that was matched.
   * - `message` - The raw message string from Redis (JSON-encoded).
   *
   * @internal
   */
  private handlePatternMessage(pattern: string, channel: string, message: string): void {
    const handlers = this.patternSubscriptions.get(pattern);
    if (!handlers) return;

    let parsed: any = message;
    try { parsed = JSON.parse(message); } catch {}

    for (const handler of handlers) {
      try {
        handler({ channel, message: parsed });
      } catch (error) {
        this.logger.error('Handler error:', error as Record<string, any>);
      }
    }
  }

  /**
   * Publishes a message to a channel.
   *
   * Non-string values are JSON-serialized.
   *
   * @param channel - The channel name.
   * @param message - The message payload (string or any JSON-serializable value).
   * @returns The number of subscribers that received the message.
   *
   * @example
   * ```ts
   * const receivers = await pubsub.publish('orders:created', { id: 1, total: 99 });
   * ```
   */
  /**
   * Publishes a message to a channel.
   *
   * **Behavior:**
   * - Non-string values are JSON-serialized automatically.
   * - The raw message is published to the Redis channel.
   * - Returns the number of subscribers that received the message.
   *
   * **Type Parameters:**
   * - `T` - The type of the message payload. Non-string values are JSON-serialized.
   *
   * **Returns:**
   * - The number of subscribers that received the message.
   *
   * **Example:**
   * ```ts
   * const receivers = await pubsub.publish('orders:created', { id: 1, total: 99 });
   * // receivers === number of subscribed clients
   * ```
   *
   * **Parameters:**
   * - `channel` - The channel name.
   * - `message` - The message payload (string or any JSON-serializable value).
   *
   * @returns The number of subscribers that received the message.
   */
  async publish<T = any>(channel: string, message: T): Promise<number> {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    return this.publisher.raw.publish(channel, raw);
  }

  /**
   * Subscribes a handler to a channel.
   *
   * Multiple handlers per channel are supported; the channel is subscribed on
   * Redis only once. Delivered payloads are JSON-parsed when possible.
   *
   * @param channel - The channel name.
   * @param handler - Callback receiving the (parsed) message.
   * @throws `Error` if the subscriber connection is not open.
   *
   * @example
   * ```ts
   * await pubsub.subscribe('orders:created', (order) => {
   *   console.log(order.id);
   * });
   * ```
   */
  /**
   * Subscribes a handler to a channel.
   *
   * **Behavior:**
   * - Multiple handlers per channel are supported; the channel is subscribed on
   *   Redis only once.
   * - Delivered payloads are JSON-parsed when possible.
   * - Throws an error if the subscriber connection is not open.
   *
   * **Type Parameters:**
   * - `T` - The type of the message data received in the handler.
   *
   * **Returns:**
   * - `Promise<void>` that resolves when the subscription is established.
 *
   * **Example:**
   * ```ts
   * await pubsub.subscribe('orders:created', (order) => {
   *   console.log(order.id);
   * });
   * ```
   *
   * **Parameters:**
   * - `channel` - The channel name.
   * - `handler` - Callback receiving the (parsed) message.
   *
   * @throws `Error` if the subscriber connection is not open.
   */
  async subscribe<T = any>(
    channel: string,
    handler: (data: T) => void
  ): Promise<void> {
    if (!this.subscriber) {
      throw new Error('Subscriber not connected');
    }

    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      await this.subscriber.raw.subscribe(channel);
    }

    this.subscriptions.get(channel)!.add(handler);
    this.logger.debug('Subscribed to channel', { channel });
  }

  /**
   * Removes a handler (or all handlers) from a channel.
   *
   * The Redis subscription is dropped once the last handler for the channel is
   * removed. Without a handler, the whole channel is unsubscribed.
   *
   * @param channel - The channel name.
   * @param handler - Optional specific handler to remove; when omitted all
   *   handlers for the channel are removed.
   *
   * @example
   * ```ts
   * await pubsub.unsubscribe('orders:created', myHandler);
   * await pubsub.unsubscribe('orders:created'); // remove everything
   * ```
   */
  /**
   * Removes a handler (or all handlers) from a channel.
   *
   * **Behavior:**
   * - The Redis subscription is dropped once the last handler for the channel is
   *   removed.
   * - Without a handler, the whole channel is unsubscribed.
   *
   * **Returns:**
   * - `Promise<void>` that resolves when the unsubscription is complete.
 *
   * **Example:**
   * ```ts
   * await pubsub.unsubscribe('orders:created', myHandler);
   * await pubsub.unsubscribe('orders:created'); // remove everything
   * ```
   *
   * **Parameters:**
   * - `channel` - The channel name.
   * - `handler` - Optional specific handler to remove; when omitted all
   *   handlers for the channel are removed.
   */
  async unsubscribe<T = any>(
    channel: string,
    handler?: (data: T) => void
  ): Promise<void> {
    if (!this.subscriber) return;

    if (handler && this.subscriptions.has(channel)) {
      const handlers = this.subscriptions.get(channel)!;
      handlers.delete(handler);

      if (handlers.size === 0) {
        this.subscriptions.delete(channel);
        await this.subscriber.raw.unsubscribe(channel);
      }
    } else {
      this.subscriptions.delete(channel);
      await this.subscriber.raw.unsubscribe(channel);
    }
  }

  /**
   * Subscribes a handler to all channels matching a glob pattern.
   *
   * Pattern handlers receive `{ channel, message }` (message JSON-parsed).
   *
   * @param pattern - Glob pattern, e.g. `'orders:*'`.
   * @param handler - Callback receiving `{ channel, message }`.
   * @throws `Error` if the subscriber connection is not open.
   *
   * @example
   * ```ts
   * await pubsub.psubscribe('orders:*', ({ channel, message }) => {
   *   console.log(channel, message);
   * });
   * ```
   */
/**
   * Subscribes a handler to all channels matching a glob pattern.
   *
   * **Behavior:**
   * - Pattern handlers receive `{ channel, message }` (message JSON-parsed).
   * - The Redis subscription is set up once per pattern.
   *
   * **Type Parameters:**
   * - `T` - The type of the message data received in the handler.
   *
   * **Returns:**
   * - `Promise<void>` that resolves when the pattern subscription is established.
 *
   * **Example:**
   * ```ts
   * await pubsub.psubscribe('orders:*', ({ channel, message }) => {
   *   console.log(channel, message);
   * });
   * ```
   *
   * **Parameters:**
   * - `pattern` - Glob pattern, e.g. `'orders:*'`.
   * - `handler` - Callback receiving `{ channel, message }`.
   *
   * @throws `Error` if the subscriber connection is not open.
   */
  async psubscribe<T = any>(
    pattern: string,
    handler: (data: { channel: string; message: T }) => void
  ): Promise<void> {
    if (!this.subscriber) {
      throw new Error('Subscriber not connected');
    }

    if (!this.patternSubscriptions.has(pattern)) {
      this.patternSubscriptions.set(pattern, new Set());
      await this.subscriber.raw.psubscribe(pattern);
    }

    this.patternSubscriptions.get(pattern)!.add(handler);
  }

  /**
   * Removes a handler (or all handlers) from a pattern subscription.
   *
   * @param pattern - The glob pattern.
   * @param handler - Optional specific handler to remove; when omitted all
   *   handlers for the pattern are removed.
   *
   * @example
   * ```ts
   * await pubsub.punsubscribe('orders:*', myHandler);
   * await pubsub.punsubscribe('orders:*');
   * ```
   */
  /**
   * Removes a handler (or all handlers) from a pattern subscription.
   *
   * **Returns:**
   * - `Promise<void>` that resolves when the punsubscription is complete.
   *
   * **Example:**
   * ```ts
   * await pubsub.punsubscribe('orders:*', myHandler);
   * await pubsub.punsubscribe('orders:*');
   * ```
   *
   * **Parameters:**
   * - `pattern` - The glob pattern.
   * - `handler` - Optional specific handler to remove; when omitted all
   *   handlers for the pattern are removed.
   */
  async punsubscribe(
    pattern: string,
    handler?: (data: any) => void
  ): Promise<void> {
    if (!this.subscriber) return;

    if (handler && this.patternSubscriptions.has(pattern)) {
      const handlers = this.patternSubscriptions.get(pattern)!;
      handlers.delete(handler);

      if (handlers.size === 0) {
        this.patternSubscriptions.delete(pattern);
        await this.subscriber.raw.punsubscribe(pattern);
      }
    } else {
      this.patternSubscriptions.delete(pattern);
      await this.subscriber.raw.punsubscribe(pattern);
    }
  }

  /**
   * Closes the subscriber connection and clears all subscriptions.
   *
   * The publisher client is not closed (it is owned by the caller).
   *
   * @example
   * ```ts
   * await pubsub.close();
   * ```
   */
  /**
   * Closes the subscriber connection and clears all subscriptions.
   *
   * **Behavior:**
   * - The publisher client is not closed (it is owned by the caller).
   * - All subscriptions are cleared from memory.
   *
   * **Example:**
   * ```ts
   * await pubsub.close();
   * ```
   *
   * @returns `Promise<void>` that resolves when the subscriber is closed.
   */
  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.close();
      this.subscriber = null;
    }
    this.subscriptions.clear();
    this.patternSubscriptions.clear();
  }

  /**
   * Returns subscription statistics.
   *
   * @returns `{ subscriptions, patternSubscriptions, connected }`.
   *
   * @example
   * ```ts
   * const stats = pubsub.getStats();
   * // { subscriptions: 2, patternSubscriptions: 1, connected: true }
   * ```
   */
  /**
   * Returns subscription statistics.
   *
   * **Returns:**
   * - A {@link PubSubStats} object with the current subscription state.
   *
   * **Example:**
   * ```ts
   * const stats = pubsub.getStats();
   * // { subscriptions: 2, patternSubscriptions: 1, connected: true }
   * ```
   *
   * @returns `{ subscriptions, patternSubscriptions, connected }`.
   */
  getStats() {
    return {
      subscriptions: this.subscriptions.size,
      patternSubscriptions: this.patternSubscriptions.size,
      connected: this.subscriber !== null,
    };
  }
}
