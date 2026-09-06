import { z } from "zod";
import { SessionConfigurationError } from "./errors.js";

/** Runtime schema for session configuration and security invariants. */
export const SessionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    namespace: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/)
      .default("app"),
    tokenBytes: z.number().int().min(32).max(128).default(32),
    ttl: z
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
    idleTimeout: z.number().int().positive().optional(),
    absoluteTimeout: z.number().int().positive().optional(),
    touchInterval: z.number().int().nonnegative().default(60),
    rolling: z.boolean().default(true),
    securityVersionEnabled: z.boolean().default(false),
    maxSessionsPerUser: z.number().int().nonnegative().max(1_000).default(20),
    maxMetadataBytes: z
      .number()
      .int()
      .positive()
      .max(64 * 1024)
      .default(8 * 1024),
    maxBatchSize: z.number().int().positive().max(1_000).default(200),
    maxConcurrency: z.number().int().positive().max(64).default(8),
    storeIpAddress: z.boolean().default(false),
    storeUserAgent: z.boolean().default(false),
    storeDeviceId: z.boolean().default(false),
    encryption: z
      .object({ enabled: z.boolean().default(false) })
      .default({ enabled: false }),
    circuitBreaker: z
      .object({
        enabled: z.boolean().default(false),
        failureThreshold: z.number().int().positive().default(5),
        resetTimeoutMs: z.number().int().positive().default(10_000),
        halfOpenMaxRequests: z.number().int().positive().default(1),
      })
      .default({
        enabled: false,
        failureThreshold: 5,
        resetTimeoutMs: 10_000,
        halfOpenMaxRequests: 1,
      }),
    cookie: z
      .object({
        name: z.string().min(1).max(256).default("session"),
        httpOnly: z.boolean().default(true),
        secure: z.boolean().default(true),
        sameSite: z.enum(["strict", "lax", "none"]).default("lax"),
        domain: z.string().optional(),
        path: z.string().default("/"),
        maxAge: z.number().int().positive().optional(),
      })
      .default({
        name: "session",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      }),
  })
  .superRefine((c, ctx) => {
    if (
      c.absoluteTimeout !== undefined &&
      c.idleTimeout !== undefined &&
      c.idleTimeout > c.absoluteTimeout
    )
      ctx.addIssue({
        code: "custom",
        path: ["idleTimeout"],
        message: "idleTimeout must not exceed absoluteTimeout",
      });
    if (c.absoluteTimeout !== undefined && c.ttl > c.absoluteTimeout)
      ctx.addIssue({
        code: "custom",
        path: ["ttl"],
        message: "ttl must not exceed absoluteTimeout",
      });
    if (c.cookie.sameSite === "none" && !c.cookie.secure)
      ctx.addIssue({
        code: "custom",
        path: ["cookie", "secure"],
        message: "SameSite=None requires Secure",
      });
  });
/** Fully normalized session configuration returned by {@link parseSessionConfig}. */
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
/** Validates and applies secure defaults to session configuration. */
export function parseSessionConfig(input: unknown): SessionConfig {
  const result = SessionConfigSchema.safeParse(input ?? {});
  if (!result.success)
    throw new SessionConfigurationError(
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  return result.data;
}
