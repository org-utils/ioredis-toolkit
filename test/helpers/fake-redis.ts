import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import RedisMock from 'ioredis-mock';

import { RedisClientWrapper } from '../../src/client.js';
import { defaultLogger, LoggerLike } from '../../src/logger.js';
import { calculateRedisClusterSlot } from '../../src/cluster-slot.js';

/**
 * ioredis-mock executes Lua through fengari but does not provide the `cjson`
 * library the session scripts use. Patch the shared fengari state setup once
 * so every mocked EVAL/EVALSHA gets `cjson.encode`, `cjson.decode` and
 * `cjson.null`.
 */
let luaGlobalsPatched = false;

function patchLuaGlobals(): void {
  if (luaGlobalsPatched) return;
  luaGlobalsPatched = true;

  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const fengari = require('fengari') as any;
    const { lua, lualib, to_luastring } = fengari;

    const MARKER_FIELD = 'mockJsonNull';
    const originalOpenLibs = lualib.luaL_openlibs;

    lualib.luaL_openlibs = function patchedOpenLibs(L: unknown): void {
      originalOpenLibs(L);

      const absIndex = (L2: any, index: number): number =>
        index < 0 ? lua.lua_gettop(L2) + index + 1 : index;

      // Marker table standing in for JSON null; equal to every other marker.
      const pushNullMarker = (L2: any): void => {
        lua.lua_newtable(L2);
        lua.lua_pushboolean(L2, true);
        lua.lua_setfield(L2, -2, to_luastring(MARKER_FIELD));
        lua.lua_newtable(L2);
        lua.lua_pushjsfunction(L2, (L3: unknown) => {
          lua.lua_pushboolean(L3, true);
          return 1;
        });
        lua.lua_setfield(L2, -2, to_luastring('__eq'));
        lua.lua_setmetatable(L2, -2);
      };

      const isNullMarker = (L2: any, index: number): boolean => {
        lua.lua_getfield(L2, index, to_luastring(MARKER_FIELD));
        const marker = lua.lua_toboolean(L2, -1);
        lua.lua_pop(L2, 1);
        return marker === true;
      };

      const encodeAt = (L2: any, index: number): string => {
        switch (lua.lua_type(L2, index)) {
          case lua.LUA_TSTRING:
            return JSON.stringify(lua.lua_tojsstring(L2, index));
          case lua.LUA_TNUMBER:
            return String(lua.lua_tonumber(L2, index));
          case lua.LUA_TBOOLEAN:
            return lua.lua_toboolean(L2, index) ? 'true' : 'false';
          case lua.LUA_TNIL:
          case lua.LUA_TNONE:
            return 'null';
          case lua.LUA_TTABLE: {
            if (isNullMarker(L2, index)) {
              return 'null';
            }
            const tableIndex = absIndex(L2, index);
            const entries: Array<[number | string, string]> = [];
            let count = 0;
            let maxSequence = 0;
            lua.lua_pushnil(L2);
            while (lua.lua_next(L2, tableIndex) !== 0) {
              const keyType = lua.lua_type(L2, -2);
              const key =
                keyType === lua.LUA_TNUMBER
                  ? Number(lua.lua_tonumber(L2, -2))
                  : String(lua.lua_tojsstring(L2, -2));
              entries.push([key, encodeAt(L2, -1)]);
              count += 1;
              if (
                keyType === lua.LUA_TNUMBER &&
                Number.isInteger(key)
              ) {
                maxSequence = Math.max(maxSequence, key as number);
              }
              lua.lua_pop(L2, 1);
            }
            if (count === 0) return '{}';
            if (
              maxSequence === count &&
              entries.every(([key]) => typeof key === 'number')
            ) {
              return `[${(entries as Array<[number, string]>)
                .sort((a, b) => a[0] - b[0])
                .map((entry) => entry[1])
                .join(',')}]`;
            }
            return `{${entries
              .map(([key, value]) => `${JSON.stringify(String(key))}:${value}`)
              .join(',')}}`;
          }
          default:
            throw new Error(
              `cjson.encode: unsupported type ${String(lua.lua_typename(L2, lua.lua_type(L2, index)))}`,
            );
        }
      };

      // Builds a native Lua value tree from parsed JSON.
      const pushDecoded = (L2: any, value: unknown): void => {
        if (value === null) {
          pushNullMarker(L2);
          return;
        }
        if (Array.isArray(value)) {
          lua.lua_createtable(L2, value.length, 0);
          value.forEach((item, i) => {
            lua.lua_pushinteger(L2, i + 1);
            pushDecoded(L2, item);
            lua.lua_settable(L2, -3);
          });
          return;
        }
        if (typeof value === 'object') {
          lua.lua_createtable(L2, 0, Object.keys(value).length);
          for (const [key, item] of Object.entries(
            value as Record<string, unknown>,
          )) {
            lua.lua_pushstring(L2, to_luastring(key));
            pushDecoded(L2, item);
            lua.lua_settable(L2, -3);
          }
          return;
        }
        if (typeof value === 'string') {
          lua.lua_pushstring(L2, to_luastring(value));
          return;
        }
        if (typeof value === 'number') {
          if (Number.isInteger(value)) {
            lua.lua_pushinteger(L2, value);
          } else {
            lua.lua_pushnumber(L2, value);
          }
          return;
        }
        if (typeof value === 'boolean') {
          lua.lua_pushboolean(L2, value);
          return;
        }
        throw new Error(`cjson.decode: unsupported value ${String(value)}`);
      };

      lua.lua_newtable(L);
      const cjsonTable = lua.lua_gettop(L);

      lua.lua_pushjsfunction(L, (L2: unknown) => {
        const encoded = encodeAt(L2, 1);
        lua.lua_pushstring(L2, to_luastring(encoded));
        return 1;
      });
      lua.lua_setfield(L, cjsonTable, to_luastring('encode'));

      lua.lua_pushjsfunction(L, (L2: unknown) => {
        const text = lua.lua_tojsstring(L2, 1);
        pushDecoded(L2, JSON.parse(text === '' ? 'null' : text));
        return 1;
      });
      lua.lua_setfield(L, cjsonTable, to_luastring('decode'));

      pushNullMarker(L);
      lua.lua_setfield(L, cjsonTable, to_luastring('null'));

      lua.lua_setglobal(L, to_luastring('cjson'));
    };
  } catch {
    // fengari unavailable: Lua scripts simply won't support cjson.
  }
}

patchLuaGlobals();

export const silentLogger: LoggerLike = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

/**
 * Test double backed by `ioredis-mock`, exposing the {@link RedisClientWrapper}
 * surface the unit/integration tests exercise. Unknown command calls fall
 * through to the underlying mock client, so every Redis command is available.
 */
export class FakeRedis {
  /**
   * ioredis-mock shares data between instances using the same host/port,
   * so each fake gets a unique port to keep suites isolated.
   */
  private static nextPort = 10_000;

  private readonly client: InstanceType<typeof RedisMock>;
  private readonly proxyRef?: FakeRedis;
  private failingMethods = new Set<string>();
  private closed = false;
  public callLog: string[] = [];

  constructor() {
    FakeRedis.nextPort += 1;
    this.client = new RedisMock({ port: FakeRedis.nextPort });
  }

  /** Returns a proxied self that forwards unknown commands to the mock client. */
  static create(): FakeRedis {
    const instance = new FakeRedis();
    return new Proxy(instance, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) {
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' && prop !== 'constructor'
            ? value.bind(target)
            : value;
        }

        // Not part of the fake's API: delegate Redis commands to ioredis-mock.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegated = (target as any).client[prop];
        if (typeof delegated !== 'function') {
          return undefined;
        }
        return (...args: unknown[]) => {
          target.assertOpen();
          target.checkFail(prop);
          target.log(prop, args[0]);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return delegated.apply((target as any).client, args);
        };
      },
    }) as FakeRedis;
  }

  fail(...methods: string[]): void {
    methods.forEach((m) => this.failingMethods.add(m));
  }

  private checkFail(method: string): void {
    if (this.failingMethods.has(method)) {
      throw new Error(`Simulated Redis failure: ${method}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Connection is closed.');
    }
  }

  private log(method: string, key: unknown): void {
    this.callLog.push(`${method} ${String(key)}`);
  }

  private run<T>(method: string, key: unknown, operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.checkFail(method);
    this.log(method, key);
    return operation();
  }

  async get(key: string): Promise<string | null> {
    return this.run('get', key, () => this.client.get(key));
  }

  /**
   * Accepts both the wrapper signature `set(key, value, ttlSeconds)` and the
   * raw ioredis signature `set(key, value, 'EX', ttl, ...)`.
   */
  async set(
    key: string,
    value: string | Buffer,
    ...rest: unknown[]
  ): Promise<'OK' | null> {
    return this.run('set', key, () => {
      const args =
        typeof rest[0] === 'number'
          ? ['EX', rest[0], ...rest.slice(1)]
          : rest;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.client.set as any)(key, value, ...args);
    });
  }

  async setexnx(
    key: string,
    value: string | Buffer,
    ttl?: number,
  ): Promise<'OK' | null> {
    return this.run('setexnx', key, () => {
      const args =
        ttl !== undefined ? ['EX', ttl, 'NX'] : ['NX'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.client.set as any)(key, value, ...args);
    });
  }

  async setnx(
    key: string,
    value: string | Buffer,
    ttl?: number,
  ): Promise<number> {
    return this.run('setnx', key, async () => {
      const result =
        ttl !== undefined
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (this.client.set as any)(key, value, 'EX', ttl, 'NX')
          : await this.client.setnx(key, value);
      return result === 'OK' ? 1 : 0;
    });
  }

  async del(...keys: string[]): Promise<number> {
    return this.run('del', keys.join(','), () => this.client.del(...keys));
  }

  async exists(key: string): Promise<number> {
    return this.run('exists', key, () => this.client.exists(key));
  }

  async expire(key: string, ttl: number): Promise<number> {
    return this.run('expire', key, () => this.client.expire(key, ttl));
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    return this.run('pexpire', key, () => this.client.pexpire(key, ttlMs));
  }

  async persist(key: string): Promise<number> {
    return this.run('persist', key, () => this.client.persist(key));
  }

  async ttl(key: string): Promise<number> {
    return this.run('ttl', key, () => this.client.ttl(key));
  }

  async incr(key: string): Promise<number> {
    return this.run('incr', key, () => this.client.incr(key));
  }

  async decr(key: string): Promise<number> {
    return this.run('decr', key, () => this.client.decr(key));
  }

  async incrby(key: string, amount: number): Promise<number> {
    return this.run('incrby', key, () => this.client.incrby(key, amount));
  }

  async decrby(key: string, amount: number): Promise<number> {
    return this.run('decrby', key, () => this.client.decrby(key, amount));
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.run('mget', keys.join(','), () => this.client.mget(...keys));
  }

  async mgetClusterAware(keys: string[]): Promise<(string | null)[]> {
    return this.run('mget', keys.join(','), () => this.mget(...keys));
  }

  async mset(...pairs: Array<[string, string | Buffer]>): Promise<'OK'> {
    const flat = pairs.flat();
    return this.run('mset', flat[0] ?? '', async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.client.mset as any)(...flat),
    );
  }

  async getdel(key: string): Promise<string | null> {
    return this.run('getdel', key, () => this.client.getdel(key));
  }

  hget(key: string, field: string): Promise<string | null> {
    return this.run('hget', key, () => this.client.hget(key, field));
  }

  hset(
    key: string,
    field: string,
    value: string | Buffer | number,
  ): Promise<number> {
    return this.run('hset', key, () => this.client.hset(key, field, String(value)));
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return this.run('hgetall', key, () => this.client.hgetall(key));
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    return this.run('hdel', key, () => this.client.hdel(key, ...fields));
  }

  sadd(key: string, ...members: string[]): Promise<number> {
    return this.run('sadd', key, () => this.client.sadd(key, ...members));
  }

  srem(key: string, ...members: string[]): Promise<number> {
    return this.run('srem', key, () => this.client.srem(key, ...members));
  }

  smembers(key: string): Promise<string[]> {
    return this.run('smembers', key, () => this.client.smembers(key));
  }

  sismember(key: string, member: string): Promise<number> {
    return this.run('sismember', key, () => this.client.sismember(key, member));
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    return this.run('zadd', key, () => this.client.zadd(key, score, member));
  }

  zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.run('zrange', key, () => this.client.zrange(key, start, stop));
  }

  zcard(key: string): Promise<number> {
    return this.run('zcard', key, () => this.client.zcard(key));
  }

  zscore(key: string, member: string): Promise<string | null> {
    return this.run('zscore', key, () => this.client.zscore(key, member));
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    return this.run('zrem', key, () => this.client.zrem(key, ...members));
  }

  calculateSlot(key: string): number {
    return calculateRedisClusterSlot(key);
  }

  time(): Promise<number> {
    return this.run('time', '', async () => {
      // ioredis-mock rounds TIME to the nearest second; Redis (and the app
      // itself) floors it. Use the floored wall-clock second.
      const seconds = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(seconds)) {
        throw new Error('Unexpected TIME response');
      }
      return seconds;
    });
  }

  private readonly loadedScripts = new Map<string, string>();

  scriptLoad(script: string): Promise<string> {
    return this.run('scriptLoad', '', async () => {
      // ioredis-mock does not implement SCRIPT LOAD (and its table-to-JS
      // conversion is unreliable), so scripts are kept here and executed
      // through {@link runEval} when EVALSHA references them.
      const sha = createHash('sha1').update(script).digest('hex');
      this.loadedScripts.set(sha, script);
      return sha;
    });
  }

  evalsha(
    sha: string,
    script: string,
    numKeys: number,
    ...args: unknown[]
  ): Promise<unknown> {
    return this.run('evalsha', numKeys > 0 ? String(args[0]) : '', async () => {
      const source = this.loadedScripts.get(sha) ?? script;
      return this.runEval(source, numKeys, args);
    });
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: unknown[]
  ): Promise<unknown> {
    return this.run('eval', numKeys > 0 ? String(args[0]) : '', () =>
      this.runEval(script, numKeys, args),
    );
  }

  /**
   * ioredis-mock misconverts multi-element Lua table return values, so every
   * script is wrapped to serialize its result through `cjson.encode` (the
   * shim above) and the JSON text is decoded back in JS.
   */
  private async runEval(
    script: string,
    numKeys: number,
    args: unknown[],
  ): Promise<unknown> {
    // ioredis-mock rounds TIME to the nearest second, which puts its clock
    // up to 500ms ahead of the app's `Date.now()`; scripts read TIME through
    // redis.call, so shim it back to the floored wall-clock second.
    const timeShim = `
do
  local __origCall = redis.call
  redis.call = function(cmd, ...)
    if type(cmd) == 'string' and cmd:upper() == 'TIME' then
      return { tostring(os.time()), '0' }
    end
    return __origCall(cmd, ...)
  end
end
`;
    const wrapped =
      `${timeShim}local __result = (function()\n${script}\nend)()\n` +
      `return cjson.encode(__result)`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (this.client.eval as any)(wrapped, numKeys, ...args);
    if (typeof raw !== 'string') {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  ping(): Promise<'PONG'> {
    return this.run('ping', '', () => this.client.ping());
  }

  info(): Promise<string> {
    return this.run('info', '', () => this.client.info());
  }

  async quit(): Promise<'OK'> {
    this.assertOpen();
    this.closed = true;
    return 'OK';
  }

  /** Wrapper-level alias for {@link quit}. */
  async close(): Promise<void> {
    await this.quit();
  }

  get mode(): 'standalone' {
    return 'standalone';
  }

  isCluster(): boolean {
    return false;
  }

  getClusterNodes(): never[] {
    return [];
  }

  /** Wrapper-level namespace deletion over SCAN + DEL. */
  async deletePattern(pattern: string): Promise<number> {
    let deleted = 0;
    for await (const key of this.scanIterator(pattern)) {
      deleted += await this.del(key);
    }
    return deleted;
  }

  async clearNamespace(prefix: string): Promise<number> {
    return this.deletePattern(`${prefix}*`);
  }

  /**
   * Generic pipeline: every method is forwarded to the underlying mock
   * pipeline (so any command works) with fail-check and call logging.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipeline(): any {
    const self = this;
    const pipe = this.client.pipeline();
    return new Proxy(pipe, {
      get(target, prop) {
        if (prop === 'exec') {
          return (
            target.exec as unknown as (...a: unknown[]) => unknown
          ).bind(target);
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const delegated = (target as any)[prop];
        if (typeof delegated !== 'function') {
          return undefined;
        }
        return (...args: unknown[]) => {
          const name = `pipeline:${String(prop)}`;
          if (self.failingMethods.has(name)) {
            throw new Error(`Simulated Redis failure: pipeline:${String(prop)}`);
          }
          return delegated.apply(target, args);
        };
      },
    });
  }

  async *scanIterator(pattern: string): AsyncIterable<string> {
    for await (const batch of this.scanCluster(pattern)) {
      for (const key of batch) {
        yield key;
      }
    }
  }

  /** Mirrors the wrapper's SCAN loop over a single (mock) node. */
  async *scanCluster(pattern: string): AsyncIterable<string[]> {
    this.assertOpen();
    let cursor = '0';
    do {
      const [next, keys]: [string, string[]] = await this.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length > 0) {
        yield keys;
      }
    } while (cursor !== '0');
  }

  scan(
    cursor: string,
    ...args: unknown[]
  ): Promise<[string, string[]]> {
    return this.run('scan', args[1] ?? '', async () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((this.client as any).scan(cursor, ...args)) as [string, string[]],
    );
  }

  // Resolves to the proxied self (set up in `fakeClient()`) so `fail()` and
  // `quit()` semantics apply through `client.raw.<command>` calls.
  declare raw: FakeRedis;

  getRawClient(): InstanceType<typeof RedisMock> {
    return this.client;
  }
}

// `raw` must resolve to the proxied self so `fail()`/`quit()` semantics apply
// through `client.raw.<command>` calls.
Object.defineProperty(FakeRedis.prototype, 'raw', {
  get(this: FakeRedis & { proxyRef?: FakeRedis }): FakeRedis {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).proxyRef ?? this;
  },
});

export function fakeClient(): FakeRedis {
  const instance = FakeRedis.create() as FakeRedis & { proxyRef?: FakeRedis };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (instance as any).proxyRef = instance;
  return instance;
}

export function asWrapper(fake: FakeRedis): RedisClientWrapper {
  return fake as unknown as RedisClientWrapper;
}

export const testLogger = defaultLogger;
