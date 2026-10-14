---
"ioredis-toolkit": patch
---

Pub/Sub handlers can no longer crash the process, and subscription state survives failures and reconfiguration.

- Each handler call is isolated. A handler that throws, an async handler that rejects, or a received message that is not valid JSON is reported to the `onError` hook with source `pubsub-handler` and the logical `channel`, and the other handlers on the channel still run. Before, a throwing handler raised inside ioredis's event handler, and a rejecting one was an unhandled rejection; either could end the process. A non-JSON message, which was silently dropped, is now reported as a `PubSubError` with code `PUBSUB_SERIALIZATION`.
- Concurrent `subscribe()` calls to one channel share one Redis subscription, and each resolves only once Redis has confirmed it. Before, every call after the first resolved at once and could miss the first messages.
- A failed `subscribe()` removes the handler it registered, so a later `subscribe()` to the channel tries again. Before, the channel stayed dead for every later subscriber.
- `withPubSub()` throws `PubSubError` with the new code `PUBSUB_STATE` while the current subscriber has live subscriptions, instead of silently dropping them. Unsubscribe first, then reconfigure. `PubSubErrorCode` gains `'PUBSUB_STATE'`; an exhaustive `switch` over it needs the new case.
