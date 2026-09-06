/** Options used to serialize a Set-Cookie header. Values are intentionally narrow to avoid malformed headers. */
export interface CookieOptions { name: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'strict' | 'lax' | 'none'; domain?: string; path?: string; maxAge?: number; expires?: Date; }
/** Serializes a cookie value and options into a Set-Cookie-compatible header value. */
export function serializeCookie(value: string, options: CookieOptions): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(options.name)) throw new Error('Invalid cookie name');
  if (options.sameSite === 'none' && options.secure === false) throw new Error('SameSite=None requires Secure');
  // options.name is validated against the RFC 6265 cookie-name token charset above, so it is
  // already header-safe and must be emitted as-is: encodeURIComponent would percent-encode
  // several characters that charset permits (# $ & + ^ | ~), silently changing the cookie name.
  const parts = [`${options.name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  return parts.join('; ');
}
/** Serializes an expired cookie that instructs a browser to remove the named cookie. */
export function serializeDeletionCookie(options: CookieOptions): string { return serializeCookie('', { ...options, maxAge: 0, expires: new Date(0) }); }
