import { PubSubError, parsePubSubConfig } from 'ioredis-toolkit/pubsub';
import type { PubSubConfig, PubSubErrorCode, PubSubMessage, RedisPubSub, Subscription } from 'ioredis-toolkit/pubsub';

export const configured: PubSubConfig = parsePubSubConfig({ enabled: true, namespace: 'app:event' });
export const section: Partial<PubSubConfig> = { enabled: true, maxMessageBytes: 64 * 1024 };

interface OrderCreated { orderId: string }

export function onOrderCreated(pubsub: RedisPubSub, handle: (order: OrderCreated) => void): Promise<Subscription> {
  const deliver = (message: PubSubMessage<OrderCreated>): void => handle(message.value);
  return pubsub.subscribe<OrderCreated>('orders.created', deliver);
}

export function failureKind(error: unknown): PubSubErrorCode | undefined {
  return error instanceof PubSubError ? error.code : undefined;
}
