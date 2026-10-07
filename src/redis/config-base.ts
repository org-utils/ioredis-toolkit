import { z } from 'zod';

/** The configuration every module shares. */
export interface ModuleConfigBase {
  /** Whether the application has enabled the module. */
  enabled: boolean;
  /** Namespace: the first segment of every key or channel the module writes. */
  namespace: string;
}

/** Byte-cap bounds for a module that limits an encoded payload. */
export interface ByteCapOptions {
  /** Cap applied when the application configures none. Defaults to 1 MiB. */
  default?: number;
  /** Largest cap an application may configure. Defaults to 16 MiB. */
  max?: number;
}

/** Schema for {@link ModuleConfigBase}. A namespace may not carry a hash tag or a glob character, which would change the keys an operation reaches. */
export function moduleConfigSchema(defaultNamespace: string): z.ZodObject<{ enabled: z.ZodDefault<z.ZodBoolean>; namespace: z.ZodDefault<z.ZodString> }> {
  return z.object({
    enabled: z.boolean().default(false),
    namespace: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/).default(defaultNamespace),
  });
}

/** Schema for a cap, in bytes, on the UTF-8 encoded size of a payload. */
export function byteCap(options: ByteCapOptions = {}): z.ZodDefault<z.ZodNumber> {
  return z.number().int().positive().max(options.max ?? 16 * 1024 * 1024).default(options.default ?? 1024 * 1024);
}
