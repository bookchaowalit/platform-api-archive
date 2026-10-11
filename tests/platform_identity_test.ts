import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PlatformInputError } from '../../api/platform/errors.js';
import {
  createJwksCache,
  identityConfigFromEnv,
  verifySessionRequest,
  verifySessionToken,
  type IdentityConfig,
} from '../../api/platform/identity.js';

const NOW = Date.parse('2026-10-04T06:00:00Z');
const NOW_S = NOW / 1000;
const ISSUER = 'https://clerk.example.test';
const CONFIG: IdentityConfig = {
  issuer: ISSUER,
  jwksUrl: `${ISSUER}/.well-known/jwks.json`,
  audience: [],
  authorizedParties: [],
};

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string) {
  return { ...key.export({ format: 'jwk' }), kid, use: 'sig' };
}

function b64(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function mint(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: KeyObject } = {}) {
  const alg = opts.alg || 'RS256';
  const input = `${b64({ alg, kid: opts.kid ?? 'rsa-1', typ: 'JWT' })}.${b64(claims)}`;
  const key = opts.key || rsa.privateKey;
  const signature = alg === 'ES256'
    ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : sign('sha256', Buffer.from(input), key);
  return `${input}.${signature.toString('base64url')}`;
}

function jwksFetch(keys: unknown[], calls = { count: 0 }) {
  return (async () => {
    calls.count += 1;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
}

const base = { iss: ISSUER, sub: 'user_123', sid: 'sess_1', iat: NOW_S - 10, nbf: NOW_S - 10, exp: NOW_S + 60 };
const options = (keys = [jwk(rsa.publicKey, 'rsa-1'), jwk(ec.publicKey, 'ec-1')]) => ({
  jwks: createJwksCache(jwksFetch(keys), () => NOW),
  now: () => NOW,
});

test('accepts a valid RS256 and ES256 session and returns identifiers only', async () => {
  const result = await verifySessionToken(mint({ ...base, o: { id: 'org_9' }, email: 'a@b.test' }), CONFIG, options());
  assert.deepEqual(result, {
    valid: true,
    user_id: 'user_123',
    session_id: 'sess_1',
    org_id: 'org_9',
    issuer: ISSUER,
    issued_at: new Date((NOW_S - 10) * 1000).toISOString(),
    expires_at: new Date((NOW_S + 60) * 1000).toISOString(),
  });
  const es = await verifySessionToken(mint(base, { alg: 'ES256', kid: 'ec-1', key: ec.privateKey }), CONFIG, options());
  assert.equal(es.valid, true);
});

test('rejects tampered, foreign-key, alg=none, and malformed tokens', async () => {
  const opts = options();
  const token = mint(base);
  const [h, , s] = token.split('.');
  const tampered = `${h}.${b64({ ...base, sub: 'admin' })}.${s}`;
  assert.deepEqual(await verifySessionToken(tampered, CONFIG, opts), { valid: false, reason: 'bad_signature' });
  assert.deepEqual(
    await verifySessionToken(mint(base, { key: other.privateKey }), CONFIG, opts),
    { valid: false, reason: 'bad_signature' },
  );
  const none = `${b64({ alg: 'none' })}.${b64(base)}.x`;
  assert.deepEqual(await verifySessionToken(none, CONFIG, opts), { valid: false, reason: 'unsupported_alg' });
  assert.deepEqual(await verifySessionToken('a.b', CONFIG, opts), { valid: false, reason: 'malformed' });
  // An RS256 header pointing at the EC key must not be verified with it.
  assert.deepEqual(
    await verifySessionToken(mint(base, { kid: 'ec-1' }), CONFIG, opts),
    { valid: false, reason: 'unknown_key' },
  );
});

test('enforces issuer, expiry, not-before, audience, and authorized party', async () => {
  const opts = options();
  const check = (claims: Record<string, unknown>, config = CONFIG) => verifySessionToken(mint(claims), config, opts);
  assert.equal((await check({ ...base, iss: 'https://evil.test' })).valid, false);
  assert.deepEqual(await check({ ...base, exp: NOW_S - 31 }), { valid: false, reason: 'expired' });
  assert.equal((await check({ ...base, exp: NOW_S - 5 })).valid, true, 'within leeway');
  assert.deepEqual(await check({ ...base, nbf: NOW_S + 120 }), { valid: false, reason: 'not_yet_valid' });
  assert.deepEqual(await check(base, { ...CONFIG, audience: ['app-a'] }), { valid: false, reason: 'wrong_audience' });
  assert.equal((await check({ ...base, aud: ['app-a', 'x'] }, { ...CONFIG, audience: ['app-a'] })).valid, true);
  assert.deepEqual(
    await check({ ...base, azp: 'https://other.test' }, { ...CONFIG, authorizedParties: ['https://app.test'] }),
    { valid: false, reason: 'wrong_party' },
  );
});

test('JWKS is cached and refetched for an unknown kid at most once a minute', async () => {
  const calls = { count: 0 };
  let clock = NOW;
  const keys: unknown[] = [jwk(rsa.publicKey, 'rsa-1')];
  const jwks = createJwksCache(jwksFetch(keys, calls), () => clock);
  const opts = { jwks, now: () => NOW };
  await verifySessionToken(mint(base), CONFIG, opts);
  await verifySessionToken(mint(base), CONFIG, opts);
  assert.equal(calls.count, 1);
  keys.push(jwk(ec.publicKey, 'ec-2'));
  const rotated = mint(base, { alg: 'ES256', kid: 'ec-2', key: ec.privateKey });
  assert.equal((await verifySessionToken(rotated, CONFIG, opts)).valid, false, 'refresh floor not reached');
  clock += 61_000;
  assert.equal((await verifySessionToken(rotated, CONFIG, opts)).valid, true);
  assert.equal(calls.count, 2);
});

test('config and request parsing', async () => {
  assert.equal(identityConfigFromEnv({}), null);
  assert.throws(() => identityConfigFromEnv({ PLATFORM_AUTH_ISSUER: 'http://insecure.test' }));
  assert.deepEqual(identityConfigFromEnv({ PLATFORM_AUTH_ISSUER: `${ISSUER}/`, PLATFORM_AUTH_AUDIENCE: 'a, b' }), {
    issuer: ISSUER,
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    audience: ['a', 'b'],
    authorizedParties: [],
  });
  await assert.rejects(verifySessionRequest({}, CONFIG, options()), PlatformInputError);
  assert.equal((await verifySessionRequest({ token: `Bearer ${mint(base)}` }, CONFIG, options())).valid, true);
});
