import { SessionStorageError } from './errors.js';
import { ScriptRegistry, type RedisClientWrapper } from '../redis/index.js';
import { SCRIPT_SOURCES } from './script-sources.js';

/** Names of versioned Lua scripts used by the session repository. */
export type ScriptName = keyof typeof SCRIPT_SOURCES;
/** Executes versioned session Lua scripts through the kernel script registry, reporting failures as session storage errors. */
export class SessionScriptRegistry {
  private readonly scripts: ScriptRegistry<ScriptName>;
  /** Creates a script registry backed by the shared Redis client. */
  constructor(redis: RedisClientWrapper) { this.scripts = new ScriptRegistry(redis, SCRIPT_SOURCES); }
  /** Executes a named script with explicit KEYS and ARGV, recovering from NOSCRIPT. */
  async eval(name: ScriptName, keys: string[], args: string[]): Promise<unknown> {
    if (!keys.length) throw new SessionStorageError('Lua script requires at least one key');
    try { return await this.scripts.eval(name, keys, args); }
    catch (error) { throw new SessionStorageError('Redis script execution failed', error); }
  }
}
