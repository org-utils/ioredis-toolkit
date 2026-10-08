import { createHash } from 'node:crypto';
import type { RedisCommandClient } from './types.js';

/**
 * Runs a module's Lua scripts by cached SHA, so a call sends the script's SHA-1 and not its body.
 *
 * A server that does not hold a script (first use, restart, failover, `SCRIPT FLUSH`) answers
 * NOSCRIPT. The source is then sent once with EVAL, which also caches it for the calls that follow.
 */
export class ScriptRegistry<Name extends string> {
  private readonly shas = new Map<Name, string>();
  /** Creates a registry of named Lua sources, executed on the shared Redis client. */
  constructor(private readonly redis: Pick<RedisCommandClient, 'evalsha' | 'eval'>, private readonly sources: Readonly<Record<Name, string>>) {}
  private sha(name: Name): string {
    let sha = this.shas.get(name);
    if (sha === undefined) { sha = createHash('sha1').update(this.sources[name]).digest('hex'); this.shas.set(name, sha); }
    return sha;
  }
  /** Executes a named script with explicit KEYS and ARGV, recovering from NOSCRIPT. Any other failure passes through as Redis or the connection raised it. */
  async eval(name: Name, keys: string[], args: string[]): Promise<unknown> {
    try {
      return await this.redis.evalsha(this.sha(name), keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      return this.redis.eval(this.sources[name], keys.length, ...keys, ...args);
    }
  }
}
