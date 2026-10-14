import { Cluster, type Redis } from 'ioredis';
import { KeyStrategy, closeConnection, reportConnectionErrors, type ErrorReporter, type RedisClientWrapper } from '../redis/index.js';
import { PubSubError, type PubSubConfig, type PubSubMessage, type Subscription } from './types.js';

/** JSON Pub/Sub abstraction using a dedicated subscriber connection. */
export class RedisPubSub {
  private readonly subscriber: Redis | Cluster;
  private readonly handlers = new Map<string, Set<(message: string) => void>>();
  private readonly keys: KeyStrategy;
  /** Creates a Pub/Sub module on a duplicate of the shared connection, whose errors go to `report` and never crash the process. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: PubSubConfig, report: ErrorReporter<'subscriber'>) {
    this.keys = new KeyStrategy(config.namespace);
    this.subscriber = redis.duplicateConnection();
    reportConnectionErrors(this.subscriber, report, 'subscriber');
    this.subscriber.on('message', (channel: string, message: string) => this.handlers.get(channel)?.forEach(handler => handler(message)));
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
  /** Subscribes to a namespaced channel and parses each JSON message. */
  async subscribe<T>(channel: string, handler: (message: PubSubMessage<T>) => void): Promise<Subscription> {
    const full = this.fullChannel(channel);
    const wrapped = (raw: string) => {
      let value: T;
      try { value = JSON.parse(raw) as T; } catch { return; }
      handler({ channel, value });
    };
    const existing = this.handlers.get(full);
    const set = existing ?? new Set<(message: string) => void>(); set.add(wrapped); this.handlers.set(full, set);
    if (!existing) await this.subscriber.subscribe(full);
    return { channel, unsubscribe: async () => { set.delete(wrapped); if (set.size === 0) { this.handlers.delete(full); await this.subscriber.unsubscribe(full); } } };
  }
  /** Closes the dedicated subscriber connection. Idempotent. */
  async close(): Promise<void> { await closeConnection(this.subscriber); this.handlers.clear(); }
  /** Returns the physical namespaced channel. */
  fullChannel(channel: string): string { return this.keys.key(channel); }
}
