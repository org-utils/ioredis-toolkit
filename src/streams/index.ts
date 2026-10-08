/** The Streams module's entry point: its class, with the configuration, input, result and error types a consumer needs beside it. */
export { RedisStreams } from './streams.js';
export { parseStreamsConfig } from './config.js';
export { StreamsError } from './types.js';
export type { StreamsConfig, StreamEntry, StreamReadOptions, StreamsErrorCode } from './types.js';
