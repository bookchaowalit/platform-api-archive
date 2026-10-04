/**
 * Central end-user session verification (catalog id: authentication).
 *
 * Apps let a hosted identity provider (Clerk by default; Keycloak, Auth0, or
 * Supabase Auth also issue OIDC JWTs) run the login UI, then hand the user's
 * session token to this route instead of each app verifying JWTs itself.
 * Provider-neutral: it trusts one issuer and its public JWKS, never a client
 * secret. Unconfigured means 503; nothing here calls a provider except the
 * public JWKS fetch.
 *
 * Env: PLATFORM_AUTH_ISSUER (required), PLATFORM_AUTH_JWKS_URL (default
 * <issuer>/.well-known/jwks.json), PLATFORM_AUTH_AUDIENCE and
 * PLATFORM_AUTH_AUTHORIZED_PARTIES (comma-separated; checked when set).
 */
import { createPublicKey, verify as verifySignature, type JsonWebKeyInput } from 'crypto';
import { PlatformInputError, requireObject, requireString } from './errors.js';

const LEEWAY_SECONDS = 30;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_REFRESH_FLOOR_MS = 60_000;
const MAX_TOKEN_CHARS = 8192;
const SUPPORTED_ALGORITHMS = { RS256: 'RSA', ES256: 'EC' } as const;
type Algorithm = keyof typeof SUPPORTED_ALGORITHMS;

export interface IdentityConfig {
  issuer: string;
  jwksUrl: string;
  audience: string[];
  authorizedParties: string[];
}

function csv(value: string | undefined): string[] {
  return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export function identityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityConfig | null {
  const issuer = (env.PLATFORM_AUTH_ISSUER || '').trim().replace(/\/+$/, '');
  if (!issuer) return null;
  if (!issuer.startsWith('https://')) throw new Error('PLATFORM_AUTH_ISSUER must be an https URL');
  const jwksUrl = (env.PLATFORM_AUTH_JWKS_URL || '').trim() || `${issuer}/.well-known/jwks.json`;
  if (!jwksUrl.startsWith('https://')) throw new Error('PLATFORM_AUTH_JWKS_URL must be an https URL');
  return {
    issuer,
    jwksUrl,
    audience: csv(env.PLATFORM_AUTH_AUDIENCE),
    authorizedParties: csv(env.PLATFORM_AUTH_AUTHORIZED_PARTIES),
  };
}

type Jwk = JsonWebKeyInput['key'] & { kid?: string; use?: string; alg?: string };
type JwksEntry = { keys: Jwk[]; fetchedAt: number };

/** Per-process JWKS cache keyed by URL; refetches on an unknown kid at most once a minute. */
export function createJwksCache(fetchImpl: typeof fetch = fetch, clock: () => number = Date.now) {
  const entries = new Map<string, JwksEntry>();

  async function load(url: string): Promise<Jwk[]> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new PlatformInputError(`identity provider JWKS unavailable (HTTP ${response.status})`, 502);
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!body || !Array.isArray(body.keys)) throw new PlatformInputError('identity provider JWKS is malformed', 502);
    const keys = body.keys.filter((key): key is Jwk => Boolean(key) && typeof key === 'object');
    entries.set(url, { keys, fetchedAt: clock() });
    return keys;
  }

  return {
    async find(url: string, kid: string | undefined): Promise<Jwk | null> {
      const entry = entries.get(url);
      const fresh = entry && clock() - entry.fetchedAt < JWKS_TTL_MS;
      let keys = fresh ? entry.keys : await load(url);
      const pick = (list: Jwk[]) => list.find((key) => key.use !== 'enc' && (kid ? key.kid === kid : true)) || null;
      let key = pick(keys);
      if (!key && fresh && clock() - entry.fetchedAt >= JWKS_REFRESH_FLOOR_MS) {
        keys = await load(url);
        key = pick(keys);
      }
      return key;
    },
  };
}

const defaultJwksCache = createJwksCache();

export type SessionFailure =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'wrong_party';

export type SessionResult =
  | {
      valid: true;
      user_id: string;
      session_id: string | null;
      org_id: string | null;
      issuer: string;
      issued_at: string | null;
      expires_at: string;
    }
  | { valid: false; reason: SessionFailure };

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const fail = (reason: SessionFailure): SessionResult => ({ valid: false, reason });
const iso = (seconds: unknown) => (typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null);

export async function verifySessionToken(
  token: string,
  config: IdentityConfig,
  options: { jwks?: ReturnType<typeof createJwksCache>; now?: () => number } = {},
): Promise<SessionResult> {
  const jwks = options.jwks || defaultJwksCache;
  const nowSeconds = Math.floor((options.now || Date.now)() / 1000);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return fail('malformed');
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) return fail('malformed');

  const alg = header.alg as Algorithm;
  if (typeof alg !== 'string' || !(alg in SUPPORTED_ALGORITHMS)) return fail('unsupported_alg');
  const jwk = await jwks.find(config.jwksUrl, typeof header.kid === 'string' ? header.kid : undefined);
  if (!jwk || jwk.kty !== SUPPORTED_ALGORITHMS[alg] || (jwk.alg && jwk.alg !== alg)) return fail('unknown_key');

  let signatureOk = false;
  try {
    signatureOk = verifySignature(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      alg === 'ES256'
        ? { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }
        : createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return fail('bad_signature');

  if (claims.iss !== config.issuer) return fail('wrong_issuer');
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS <= nowSeconds) return fail('expired');
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > nowSeconds) return fail('not_yet_valid');
  if (typeof claims.iat === 'number' && claims.iat - LEEWAY_SECONDS > nowSeconds) return fail('not_yet_valid');
  if (config.audience.length) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.some((value) => typeof value === 'string' && config.audience.includes(value))) return fail('wrong_audience');
  }
  if (config.authorizedParties.length) {
    if (typeof claims.azp !== 'string' || !config.authorizedParties.includes(claims.azp)) return fail('wrong_party');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return fail('malformed');

  // Clerk v2 tokens nest the active organization under `o.id`; v1 used `org_id`.
  const org = claims.o && typeof claims.o === 'object' ? (claims.o as Record<string, unknown>).id : claims.org_id;
  return {
    valid: true,
    user_id: claims.sub,
    session_id: typeof claims.sid === 'string' ? claims.sid : null,
    org_id: typeof org === 'string' ? org : null,
    issuer: config.issuer,
    issued_at: iso(claims.iat),
    expires_at: iso(claims.exp) as string,
  };
}

/** POST /api/platform/identity/verify — body { token }. Returns identifiers only, never raw claims. */
export async function verifySessionRequest(
  input: unknown,
  config: IdentityConfig,
  options: Parameters<typeof verifySessionToken>[2] = {},
): Promise<SessionResult> {
  const token = requireString(requireObject(input), 'token', MAX_TOKEN_CHARS);
  return verifySessionToken(token.replace(/^Bearer\s+/i, ''), config, options);
}
