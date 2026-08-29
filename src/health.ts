import { RedisClientWrapper } from './client.js';
import { defaultLogger, LoggerLike } from './logger.js';



export interface HealthStatus {
  /** Whether the system is healthy. */
  healthy: boolean;
  /** Current status label. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Latency of the last ping check in milliseconds. */
  latency: number;
  /** Timestamp of when the status was recorded. */
  timestamp: Date;
  /** Additional details about the health check. */
  details: {
    /** Whether a PING command succeeded. */
    ping: boolean;
    /** Number of connected clients (when available). */
    connections?: number;
    /** Memory usage information (when available). */
    memory?: string;
  };
}

export class HealthChecker {
  private client: RedisClientWrapper;
  private logger: LoggerLike;
  private timer: NodeJS.Timeout | null = null;
  private callbacks: ((status: HealthStatus) => void)[] = [];
  private lastStatus: HealthStatus | null = null;

  /**
   * Creates a health checker instance.
   *
   * @param client - The underlying {@link RedisClientWrapper}.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const health = new HealthChecker(client);
   * ```
   */
  constructor(client: RedisClientWrapper, logger: LoggerLike = defaultLogger) {
    this.client = client;
    this.logger = logger.child({ component: 'HealthChecker' });
  }

  /**
   * Starts periodic health checks.
   *
   * **Behavior:**
   * - If a timer is already running, it is cleared and replaced with the new interval.
   * - Health checks run at the specified `interval` in milliseconds.
   * - Each check runs asynchronously; errors are logged but do not stop the interval.
   * - The first check runs immediately when `start()` is called (depending on setInterval timing).
   *
   * **Parameters:**
   * - `interval` - Check interval in milliseconds. Default: `10000` (10 seconds).
   *
   * @example
   * ```ts
   * // Check every 5 seconds
   * health.start(5000);
   *
   * // Check every 30 seconds (default)
   * health.start();
   * ```
   *
   * @returns `void`
   */
  start(interval: number = 10000): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      this.check().catch((error) => {
        this.logger.error('Health check failed:', error);
      });
    }, interval);

    this.logger.info(`Health checker started (interval: ${interval}ms)`);
  }

  /**
   * Stops the health checker.
   *
   * **Behavior:**
   * - Clears the internal timer, stopping further health checks.
   * - Logs a warning if no timer was active.
   *
   * @example
   * ```ts
   * health.stop();
   * ```
   *
   * @returns `void`
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Health checker stopped');
    }
  }

  /**
   * Runs a single health check.
   *
   * **Behavior:**
   * - Performs a PING command to verify Redis connectivity.
   * - Attempts to fetch Redis INFO for additional details (connections, memory).
   *   In cluster mode, INFO may not be available and is silently ignored.
   * - Measures latency of the PING command.
   * - Updates the internal `lastStatus` and notifies all registered callbacks.
   *
   * **Returns:**
   * - A {@link HealthStatus} object with the current health state.
   *
   * **Example:**
   * ```ts
   * const status = await health.check();
   * console.log(status.healthy, status.latency);
   * // healthy === true, latency === 1.2 (ms)
   * ```
   *
   * **Parameters:**
   * - None
   *
   * @returns Current health status.
   */
  async check(): Promise<HealthStatus> {
    const start = Date.now();
    const details: HealthStatus['details'] = {
      ping: false,
    };

    try {
      const ping = await this.client.ping();
      details.ping = ping;

      // Try to get some info
      try {
        const info = await this.client.raw.info();
        const connections = info.match(/connected_clients:(\d+)/)?.[1];
        const memory = info.match(/used_memory_human:([^\n]+)/)?.[1];

        if (connections) details.connections = parseInt(connections, 10);
        if (memory) details.memory = memory.trim();
      } catch {
        // Info not available in cluster mode
      }
    } catch (error) {
      this.logger.error('Health check error:', error as Record<string, any>);
      details.ping = false;
    }

    const latency = Date.now() - start;
    const healthy = details.ping;

    const status: HealthStatus = {
      healthy,
      status: healthy ? 'healthy' : 'unhealthy',
      latency,
      timestamp: new Date(),
      details,
    };

    this.lastStatus = status;
    this.notifyCallbacks(status);
    return status;
  }

  /**
   * Returns the most recent health check result.
   *
   * @returns The last {@link HealthStatus}, or `null` before the first check.
   *
   * @example
   * ```ts
   * const status = health.getStatus();
   * console.log(status?.healthy, status?.latency);
   * ```
   */
  /**
   * Returns the most recent health check result.
   *
   * **Returns:**
   * - The last {@link HealthStatus}, or `null` before the first check.
   *
   * **Example:**
   * ```ts
   * const status = health.getStatus();
   * console.log(status?.healthy, status?.latency);
   * ```
   *
   * **Parameters:**
   * - None
   *
   * @returns The last result, or `null`.
   */
  getStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  /**
   * Registers a callback for health status changes.
   *
   * **Behavior:**
   * - The callback is invoked whenever a health check runs and the status changes.
   * - Callbacks are invoked synchronously within the `check()` method.
   * - Multiple callbacks can be registered; they are invoked in registration order.
   *
   * **Parameters:**
   * - `callback` - A function receiving a {@link HealthStatus} object.
   *
   * @example
   * ```ts
   * health.onChange((status) => {
   *   console.log(`Health status: ${status.status}, latency: ${status.latency}ms`);
   * });
   * ```
   *
   * @returns `void`
   */
  onChange(callback: (status: HealthStatus) => void): void {
    this.callbacks.push(callback);
  }

  private notifyCallbacks(status: HealthStatus): void {
    for (const callback of this.callbacks) {
      try {
        callback(status);
      } catch (error) {
        this.logger.error('Callback error:', error as Record<string, any>);
      }
    }
  }

  /**
   * Waits until the Redis connection is healthy.
   *
   * **Behavior:**
   * - Polls {@link check} at 1-second intervals.
   * - Returns `true` as soon as `status.healthy` is `true`.
   * - Returns `false` if the timeout is reached without becoming healthy.
   *
   * **Parameters:**
   * - `timeout` - Maximum time to wait in milliseconds. Default: `30000` (30 seconds).
   *
   * **Returns:**
   * - `true` if the connection became healthy within the timeout.
   * - `false` if the timeout was reached without the connection becoming healthy.
   *
   * **Example:**
   * ```ts
   * const healthy = await health.waitForHealthy(10000);
   * // healthy === true if Redis became healthy within 10 seconds
   * ```
   *
   * @returns `true` if became healthy within timeout.
   */
  async waitForHealthy(timeout: number = 30000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const status = await this.check();
      if (status.healthy) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }
}
