import { Cluster, type Redis } from 'ioredis';
import type { RedisClientWrapper } from '../redis/wrapper.js';
import type { PubSubConfig, PubSubMessage, Subscription } from './types.js';

/** JSON Pub/Sub abstraction using a dedicated subscriber connection. */
export class RedisPubSub {
  private readonly subscriber: Redis | Cluster;
  private readonly handlers = new Map<string, Set<(message: string) => void>>();
  /** Creates a Pub/Sub module using the same connection configuration as the shared client. */
  constructor(private readonly redis: RedisClientWrapper, private readonly config: PubSubConfig) {
    this.subscriber = redis.duplicateConnection();
    this.subscriber.on('error', () => { /* prevents unhandled 'error' event crashes; add your own listener on this instance for observability */ });
    this.subscriber.on('message', (channel: string, message: string) => this.handlers.get(channel)?.forEach(handler => handler(message)));
  }
  /** Publishes a JSON value to a namespaced channel and returns subscriber count. */
  async publish<T>(channel: string, value: T): Promise<number> {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Pub/Sub values must be JSON-serializable');
    if (Buffer.byteLength(encoded, 'utf8') > this.config.maxMessageBytes) throw new RangeError('Pub/Sub message exceeds maxMessageBytes');
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
  /** Closes the dedicated subscriber connection. */
  async close(): Promise<void> { await this.subscriber.quit(); this.handlers.clear(); }
  /** Returns the physical namespaced channel. */
  fullChannel(channel: string): string { return `${this.config.channelPrefix}:${channel}`; }
}
