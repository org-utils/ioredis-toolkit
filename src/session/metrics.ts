import type { SessionMetrics } from './types.js';
/** No-op metrics sink for applications that do not configure instrumentation. */
export class NoopMetrics implements SessionMetrics {
  /** Ignores counter increments. */
  increment(): void {}
  /** Ignores observations. */
  observe(): void {}
  /** Ignores gauge updates. */
  gauge(): void {}
}
