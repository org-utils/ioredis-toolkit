import type { Cluster, Redis } from 'ioredis';
import { KeyStrategy, closeConnection, connectionClosedError, containedReporter, reportConnectionErrors, type ErrorReporter, type RedisClientWrapper } from '../redis/index.js';
import { PubSubError, type PubSubConfig, type PubSubMessage, type Subscription } from './types.js';

/** A handler as registered: given the decoded value, it delivers the message. */
type Handler = (value: unknown) => unknown;

/** One physical channel: its logical name, the handlers on it, and the Redis subscription they all wait on. */
interface Channel { logical: string; handlers: Set<Handler>; subscribed: Promise<unknown> }

/** JSON Pub/Sub abstraction using a dedicated subscriber connection. */
export class RedisPubSub {
  /** The dedicated subscriber connection, opened by the first subscribe. */
  private subscriberConnection: Redis | Cluster | undefined;
  private closed = false;
  private readonly channels = new Map<string, Channel>();
  private readonly keys: KeyStrategy;
  /**
   * Creates a Pub/Sub module whose subscriptions run on a duplicate of the shared connection, opened by the first
   * subscribe. Errors on that connection, and every failure of a handler, go to `report` and never crash the process;
   * without a `report` they are dropped.
   * `onLiveChange` is told whether any subscription is live each time that changes.
   */
  constructor(
    private readonly redis: RedisClientWrapper,
    private readonly config: PubSubConfig,
    private readonly report: ErrorReporter<'subscriber' | 'pubsub-handler'> = containedReporter(),
    private readonly onLiveChange: (live: boolean) => void = () => undefined,
  ) {
    this.keys = new KeyStrategy(config.namespace);
  }
  /** Publishes a JSON value to a namespaced channel and returns subscriber count. */
  async publish<T>(channel: string, value: T): Promise<number> {
    let encoded: string | undefined;
    try { encoded = JSON.stringify(value); }
    catch (error) { throw new PubSubError('PUBSUB_SERIALIZATION', 'Pub/Sub values must be JSON-serializable', { cause: error }); }
    if (encoded === undefined) throw new PubSubError('PUBSUB_SERIALIZATION', 'Pub/Sub values must be JSON-serializable');
    if (Buffer.byteLength(encoded, 'utf8') > this.config.maxMessageBytes) throw new PubSubError('PUBSUB_LIMIT', 'Pub/Sub message exceeds maxMessageBytes');
    return this.redis.publish(this.fullChannel(channel), encoded);
  }
  /**
   * Subscribes to a namespaced channel and parses each JSON message. Resolves once Redis has confirmed the subscription,
   * which concurrent subscribes to one channel share. A handler that throws, or returns a promise that rejects, is
   * reported to the error hook and never stops the other handlers on the channel. A failed subscribe leaves nothing
   * behind, so the next one tries again.
   */
  async subscribe<T>(channel: string, handler: (message: PubSubMessage<T>) => void | Promise<void>): Promise<Subscription> {
    const full = this.fullChannel(channel);
    const wrapped: Handler = value => handler({ channel, value: value as T });
    let entry = this.channels.get(full);
    if (!entry) {
      entry = { logical: channel, handlers: new Set(), subscribed: this.subscriber.subscribe(full) };
      this.channels.set(full, entry);
      this.onLiveChange(true);
    }
    entry.handlers.add(wrapped);
    try { await entry.subscribed; }
    catch (error) {
      // Every subscribe waiting on this one fails with it; the first to get here forgets the channel.
      entry.handlers.delete(wrapped);
      this.forget(full, entry);
      throw error;
    }
    const subscribed = entry;
    return {
      channel,
      unsubscribe: async () => {
        subscribed.handlers.delete(wrapped);
        if (subscribed.handlers.size === 0 && this.forget(full, subscribed)) await this.subscriber.unsubscribe(full);
      },
    };
  }
  /** Closes the dedicated subscriber connection, if a subscribe opened one; a subscribe afterwards rejects. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.subscriberConnection) await closeConnection(this.subscriberConnection);
    if (this.channels.size) { this.channels.clear(); this.onLiveChange(false); }
  }
  /** Returns the physical namespaced channel. */
  fullChannel(channel: string): string { return this.keys.key(channel); }

  /** The subscriber connection, opened on first use. Once this module is closed it throws instead of opening one. */
  private get subscriber(): Redis | Cluster {
    if (this.subscriberConnection) return this.subscriberConnection;
    if (this.closed) throw connectionClosedError();
    const subscriber = this.redis.duplicateConnection();
    reportConnectionErrors(subscriber, this.report, 'subscriber');
    subscriber.on('message', (channel: string, message: string) => this.deliver(channel, message));
    return this.subscriberConnection = subscriber;
  }

  /**
   * Hands one message to every handler on its channel, each isolated from the others; all of them share the one decoded
   * value. A message that is not JSON is reported once, as `PUBSUB_SERIALIZATION`, and handed to none.
   */
  private deliver(full: string, raw: string): void {
    const entry = this.channels.get(full);
    if (!entry) return;
    const context = { source: 'pubsub-handler', channel: entry.logical } as const;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch (error) { this.report(new PubSubError('PUBSUB_SERIALIZATION', `A message on "${entry.logical}" is not valid JSON`, { cause: error }), context); return; }
    // A copy, so a handler that unsubscribes another mid-delivery does not change who this message reaches.
    for (const handler of [...entry.handlers]) {
      try {
        const result = handler(value);
        if (isThenable(result)) Promise.resolve(result).catch((error: unknown) => this.report(error, context));
      } catch (error) { this.report(error, context); }
    }
  }

  /** Drops a channel's entry if it is still the current one, and returns whether it was. */
  private forget(full: string, entry: Channel): boolean {
    if (this.channels.get(full) !== entry) return false;
    this.channels.delete(full);
    if (this.channels.size === 0) this.onLiveChange(false);
    return true;
  }
}

/** Whether a handler returned a promise, or anything else that can reject. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}
