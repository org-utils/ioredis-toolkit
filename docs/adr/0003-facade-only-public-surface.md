# The public surface is facade-only

The root barrel exported the machine room: `SessionRepository`, `SessionService`, `SessionSerializer`, `SessionKeyStrategy`, `SessionTokenManager`, `SessionScriptRegistry` (whose `eval` runs arbitrary registry Lua), `RedisClientWrapper` (a raw ~50-method command surface), and every `*ConfigSchema` Zod object. We are narrowing the public surface to module classes, their config/input/result types, the `Session*Error` hierarchy, the factory functions and the `parse*Config` functions; everything else becomes internal. We are doing it now, pre-1.0, because narrowing is the direction that breaks consumers and the window for it closes once anyone depends on the wide surface.

We chose this over keeping a documented `internal` escape hatch: an escape hatch that exists gets used, and then it is the surface.

## Consequences

Direct construction (`new RedisCache(wrapper, config)`) is no longer supported — the facade becomes the only way in, since `RedisClientWrapper` is internal. Dropping the Zod schema objects is what stops schema identity from becoming a compatibility obligation that consumers can `.extend()`; `parse*Config` stays public so config validation is still available. Separately, `CookieOptions` and `InvalidReason` must be *added* to the public surface: both are types consumers can already receive and read but cannot name.
