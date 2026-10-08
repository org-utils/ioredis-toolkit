import { SessionError, SessionReplayError, createSessionManager, createSessionManagerFromRedis, parseSessionConfig, serializeCookie, serializeDeletionCookie } from 'ioredis-toolkit/session';
import type {
  CookieOptions, CreateSessionInput, CreateSessionManagerOptions, CreatedSession, InvalidReason, KeyManager, RedisConfig, RotationResult,
  SessionConfig, SessionErrorCode, SessionManager, SessionMetrics, SessionPatch, SessionRecord, SessionStatus, ValidationResult,
} from 'ioredis-toolkit/session';

const connection: RedisConfig = { mode: 'standalone', host: '127.0.0.1', port: 6379 };
export const section: Partial<SessionConfig> = { enabled: true, namespace: 'app:session', idleTimeout: 60 * 60 };
export const configured: SessionConfig = parseSessionConfig(section);

/** The subpath constructs what it returns: no other import is needed to hold a session manager. */
export const sessions: SessionManager = createSessionManagerFromRedis(connection, section).manager;

export function encrypted(options: CreateSessionManagerOptions, encryptionKeyManager: KeyManager, metrics: SessionMetrics): SessionManager {
  return createSessionManager({ ...options, encryptionKeyManager, metrics });
}

const cookie: CookieOptions = { name: configured.cookie.name, sameSite: 'lax', path: '/' };

export async function signIn(userId: string): Promise<string> {
  const input: CreateSessionInput = { userId, metadata: { plan: 'pro' } };
  const created: CreatedSession = await sessions.create(input);
  return serializeCookie(created.token, cookie);
}

export function signOut(): string { return serializeDeletionCookie(cookie); }

export async function refresh(token: string): Promise<string> {
  const rotated: RotationResult = await sessions.rotate(token);
  return rotated.token;
}

export async function rename(token: string, deviceId: string): Promise<SessionStatus> {
  const patch: SessionPatch = { deviceId };
  const session: SessionRecord = await sessions.update(token, patch);
  return session.status;
}

/** Exhaustive over the reason union: a reason added later fails to compile here until it is handled. */
function status(reason: InvalidReason): 401 | 419 {
  switch (reason) {
    case 'expired': case 'idle_timeout': case 'absolute_timeout': return 419;
    case 'not_found': case 'revoked': case 'consumed': case 'invalid': return 401;
  }
}

export async function authenticate(token: string): Promise<SessionRecord | 401 | 419> {
  const result: ValidationResult = await sessions.validate(token);
  return result.valid ? result.session : status(result.reason);
}

export function failureKind(error: unknown): SessionErrorCode | 'replayed' | undefined {
  if (error instanceof SessionReplayError) return 'replayed';
  return error instanceof SessionError ? error.code : undefined;
}
