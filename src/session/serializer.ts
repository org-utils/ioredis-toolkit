import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SessionSerializationError } from './errors.js';
import type { KeyManager, SessionRecord } from './types.js';

interface Envelope { v: 1; enc?: 1; keyVersion?: string; iv?: string; tag?: string; data: string; }

/** Versioned serializer with optional authenticated encryption for session records. */
export class SessionSerializer {
  /** Creates a serializer. Supplying a key manager enables AES-256-GCM envelopes. */
  constructor(private readonly keyManager?: KeyManager) {}

  /** Serializes and optionally encrypts a validated session record. */
  serialize(session: SessionRecord): string {
    try {
      const sessionJson = JSON.stringify(session);
      if (!this.keyManager) return JSON.stringify({ v: 1, data: sessionJson });
      const { version, key } = this.keyManager.current();
      if (key.length !== 32) throw new SessionSerializationError('AES-256-GCM key must be 32 bytes');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(sessionJson, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope: Envelope = { v: 1, enc: 1, keyVersion: version, iv: iv.toString('base64url'), tag: tag.toString('base64url'), data: ciphertext.toString('base64url') };
      return JSON.stringify(envelope);
    } catch (error) {
      if (error instanceof SessionSerializationError) throw error;
      throw new SessionSerializationError(undefined, error);
    }
  }

  /** Parses, optionally decrypts, validates, and returns a session record. */
  deserialize(serialized: string): SessionRecord {
    try {
      const outer = JSON.parse(serialized) as unknown;
      if (!isRecord(outer) || outer.v !== 1 || typeof outer.data !== 'string') throw new Error('invalid envelope');
      let payload = outer.data;
      if (outer.enc === 1) {
        if (!this.keyManager || typeof outer.keyVersion !== 'string' || typeof outer.iv !== 'string' || typeof outer.tag !== 'string') throw new Error('encryption unavailable');
        const key = this.keyManager.get(outer.keyVersion);
        if (!key || key.length !== 32) throw new Error('unknown encryption key');
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(outer.iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(outer.tag, 'base64url'));
        payload = Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
      }
      const session = JSON.parse(payload) as unknown;
      if (!isSessionRecord(session)) throw new Error('invalid session schema');
      return session;
    } catch (error) {
      throw new SessionSerializationError(undefined, error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isOptionalString(value: unknown): boolean { return value === undefined || typeof value === 'string'; }
function isOptionalSafeInteger(value: unknown): boolean { return value === undefined || Number.isSafeInteger(value); }
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.jti === 'string' && typeof value.userId === 'string' &&
    Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.lastAccessedAt) && Number.isSafeInteger(value.expiresAt) &&
    (value.idleExpiresAt === null || Number.isSafeInteger(value.idleExpiresAt)) &&
    (value.absoluteExpiresAt === null || Number.isSafeInteger(value.absoluteExpiresAt)) &&
    (value.status === 'active' || value.status === 'consumed' || value.status === 'revoked') && Number.isSafeInteger(value.version) &&
    (value.securityVersion === null || Number.isSafeInteger(value.securityVersion)) &&
    isOptionalSafeInteger(value.idleTimeoutSeconds) &&
    isOptionalString(value.deviceId) && isOptionalString(value.ipAddress) && isOptionalString(value.userAgent) &&
    isOptionalString(value.rotatedFrom) && isOptionalString(value.successorJti) && isOptionalString(value.rotationId) &&
    isOptionalSafeInteger(value.consumedAt) &&
    (value.metadata === undefined || isRecord(value.metadata));
}
