/**
 * Presigned upload / download URLs over Cloudflare R2 (catalog id: file-upload).
 *
 * Apps never see R2 credentials: they ask this route for a short-lived URL and
 * then talk to R2 directly. Object keys are generated here under an app prefix
 * so an app cannot overwrite another app's objects. Uploads sign content-length,
 * so R2 rejects a body whose size differs from the declared one.
 */
import { createHash, createHmac, randomUUID } from 'crypto';
import { PlatformInputError, optionalString, requireObject, requireString } from './errors.js';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  maxUploadBytes: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_EXPIRES_SECONDS = 900;
const MAX_EXPIRES_SECONDS = 3600;
const APP_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\/\d{4}\/\d{2}\/[0-9a-f-]{36}-[\w.-]{1,120}$/;

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID || '';
  const bucket = env.R2_BUCKET || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  const max = Number.parseInt(env.R2_MAX_UPLOAD_BYTES || '', 10);
  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    maxUploadBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_UPLOAD_BYTES,
  };
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/** RFC 3986 encoding used by SigV4 (keeps unreserved characters only). */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface PresignInput {
  method: 'GET' | 'PUT';
  host: string;
  path: string; // already starts with '/', unencoded
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  now: Date;
  headers?: Record<string, string>; // extra signed headers (lower-case names)
}

/** AWS Signature V4 query-string presigning for S3-compatible storage. */
export function presignUrl(input: PresignInput): string {
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: input.host, ...(input.headers || {}) };
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`)
    .join('&');
  const canonicalPath = input.path.split('/').map(encodeRfc3986).join('/');
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name].trim()}\n`).join('');
  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(-120);
  return cleaned || 'file';
}

function expiresFrom(body: Record<string, unknown>): number {
  if (body.expires_seconds === undefined) return DEFAULT_EXPIRES_SECONDS;
  const value = body.expires_seconds;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 60 || value > MAX_EXPIRES_SECONDS) {
    throw new PlatformInputError(`expires_seconds must be an integer between 60 and ${MAX_EXPIRES_SECONDS}`);
  }
  return value;
}

/**
 * POST /api/platform/files/presign body:
 *   upload:   { action: 'upload', app, filename, content_type, size_bytes, expires_seconds? }
 *   download: { action: 'download', key, expires_seconds? }
 */
export function presignFile(input: unknown, config: R2Config, now = new Date(), uuid: () => string = randomUUID) {
  const body = requireObject(input);
  const action = body.action ?? 'upload';
  const expiresSeconds = expiresFrom(body);
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const sign = (method: 'GET' | 'PUT', key: string, headers?: Record<string, string>) =>
    presignUrl({
      method,
      host,
      path: `/${config.bucket}/${key}`,
      region: 'auto',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      expiresSeconds,
      now,
      headers,
    });
  const expiresAt = new Date(now.getTime() + expiresSeconds * 1000).toISOString();

  if (action === 'download') {
    const key = requireString(body, 'key', 300);
    if (!KEY_PATTERN.test(key)) throw new PlatformInputError('key is not a platform-issued object key');
    return { action, key, method: 'GET', url: sign('GET', key), expires_at: expiresAt };
  }
  if (action !== 'upload') throw new PlatformInputError('action must be upload or download');

  const app = requireString(body, 'app', 63);
  if (!APP_PATTERN.test(app)) throw new PlatformInputError('app must be a lower-case slug');
  const filename = sanitizeFilename(requireString(body, 'filename', 255));
  const contentType = optionalString(body, 'content_type', 127) ?? 'application/octet-stream';
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw new PlatformInputError('content_type must be a MIME type');
  const size = body.size_bytes;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw new PlatformInputError('size_bytes must be a positive integer');
  }
  if (size > config.maxUploadBytes) {
    throw new PlatformInputError(`size_bytes exceeds the ${config.maxUploadBytes}-byte upload limit`, 413);
  }
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `${app}/${yyyy}/${mm}/${uuid()}-${filename}`;
  const signedHeaders = { 'content-length': String(size), 'content-type': contentType };
  return {
    action: 'upload',
    key,
    method: 'PUT',
    url: sign('PUT', key, signedHeaders),
    required_headers: { 'Content-Length': String(size), 'Content-Type': contentType },
    expires_at: expiresAt,
  };
}
