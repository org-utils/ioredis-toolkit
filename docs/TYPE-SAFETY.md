# Type Safety and Verification

This package is authored for TypeScript strict mode with ESM and Node.js 22+.

## What is guaranteed by the source

- No `any` is used in package source modules.
- Public module APIs use explicit exported types.
- Redis internals are hidden behind `RedisClientWrapper`.
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

### 0.5.0 verification note

Earlier releases of this document recorded that dependency-backed `tsc`/Vitest execution could not be performed in the environment used to prepare the archive. That limitation does not apply to the 0.5.0 bug-fix pass: `bun run typecheck` (equivalently `tsc -p tsconfig.json --noEmit`), `bun run lint`, `bun run test`, and `bun run build` were all executed against the installed dependencies and passed, including a full rebuild of `dist/` verified to emit real ESM (the previously committed `dist/` had drifted to stale CommonJS output — see the Changelog). Do not treat a structural audit as a substitute for actually running these commands; the note above only documents that, for this pass, they were run.
