# Type Safety and Verification

This package is authored for TypeScript strict mode with ESM and Node.js 22+.

## What is guaranteed by the source

- No `any` is used in package source modules.
- Public module APIs use explicit exported types.
- Redis access goes through the client facade, `RedisClient`, which extends the package's command wrapper: every method of `RedisCommandClient` is public on it, while the wrapper class itself is not exported.
- Pub/Sub uses a type-only import for `Redis`, which is required when `verbatimModuleSyntax` is enabled.
- Optional properties are authored to work with `exactOptionalPropertyTypes`.
- Runtime configuration is validated before it reaches module constructors.

## Required verification

Run the following after installing dependencies:

```bash
bun install
bun run typecheck
bun run build
bun run lint
bun run test
```

Integration tests require Redis and are intentionally separated:

```bash
bun run test:integration
```

### Build output

`dist/` is not committed. `bun run build` produces it, and the release workflow builds it before publishing. Do not treat a structural audit as a substitute for actually running the commands above.
