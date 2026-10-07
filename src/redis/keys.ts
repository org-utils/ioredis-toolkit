/** Builds every key and channel a module writes under its namespace, the first segment of each. */
export class KeyStrategy {
  /** Creates a key strategy for one module's namespace. */
  constructor(readonly namespace: string) {}

  /** Builds a physical key: the namespace followed by each segment, colon-separated. */
  key(...segments: string[]): string { return [this.namespace, ...segments].join(':'); }

  /** Wraps a segment as the Redis Cluster hash tag, so every key carrying the same tag lands in one hash slot. */
  hashTag(tag: string): string { return `{${tag}}`; }
}
