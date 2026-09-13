# This is a session kit with its substrate exposed, not a toolkit of seven peers

The package ships as `ioredis-toolkit` and its README presents seven peer modules, but `session` and `redis` are ~81% of the source (1057 and 600 lines) while `cache`, `lock`, `rate-limit`, `pubsub` and `streams` are 65-102 lines each with no domain logic. We are naming that reality: `session` is the product, `redis` is the kernel it needed, and the other five are convenience wrappers published because they cost nothing to publish.

The alternative reading — that the five small modules are small because they are finished — was tested against the code and failed: they contain five independent copies of key prefixing, six near-identical config parsers, and four of them have no error type at all. They are not done; they are unfinished in five places at once.

## Consequences

Boundary questions stop being "how do seven peers relate" and become "what may the product depend on, and what is the kernel allowed to know about the product." Convenience wrappers get correctness fixes and the shared kernel, but not feature growth. A future rename of the package to match (`redis-session-kit`, as the working directory already calls it) is a live option, not a mistake.
