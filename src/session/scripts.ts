import { createHash } from 'node:crypto';
import { SessionStorageError } from './errors.js';
import type { RedisClientWrapper } from '../redis/wrapper.js';
import { SCRIPT_SOURCES } from './script-sources.js';

/** Names of versioned Lua scripts used by the session repository. */
export type ScriptName = keyof typeof SCRIPT_SOURCES;
/** Loads and executes versioned session Lua scripts. */
export class SessionScriptRegistry {
  private readonly shas = new Map<ScriptName, string>();
  /** Creates a script registry backed by the shared Redis client. */
  constructor(private readonly redis: RedisClientWrapper) {}
  private sha(name: ScriptName): string {
    let sha = this.shas.get(name);
    if (sha === undefined) { sha = createHash('sha1').update(SCRIPT_SOURCES[name]).digest('hex'); this.shas.set(name, sha); }
    return sha;
  }
  /** Executes a named script with explicit KEYS and ARGV, recovering from NOSCRIPT. */
  async eval(name: ScriptName, keys: string[], args: string[]): Promise<unknown> {
    if (!keys.length) throw new SessionStorageError('Lua script requires at least one key');
    const sha = this.sha(name);
    try {
      return await this.redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('NOSCRIPT')) throw new SessionStorageError('Redis script execution failed', error);
      try { return await this.redis.eval(SCRIPT_SOURCES[name], keys.length, ...keys, ...args); }
      catch (fallbackError) { throw new SessionStorageError('Redis script execution failed', fallbackError); }
    }
  }
}
