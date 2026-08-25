/**
 * Bounded local rate limiter for the Finance API boundary.
 *
 * This is a safe local edge guard, not a replacement for a distributed
 * gateway. It keys on the authenticated subject (or one shared anonymous
 * bucket) and never stores a raw token, IP address, query, or response.
 */

export type RateLimitDecision = {
  allowed: boolean;
  enabled: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

type Bucket = {
  windowStartedAt: number;
  count: number;
};

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_LIMIT = 10_000;
const MAX_WINDOW_MS = 3_600_000;
const MAX_BUCKETS = 10_000;

const enabledValue = (process.env.FINANCE_API_RATE_LIMIT_ENABLED || 'true').trim().toLowerCase();
const rawLimit = process.env.FINANCE_API_RATE_LIMIT || String(DEFAULT_LIMIT);
const rawWindow = process.env.FINANCE_API_RATE_WINDOW_MS || String(DEFAULT_WINDOW_MS);

let configurationError: string | null = null;
const enabled = enabledValue === 'true' ? true : enabledValue === 'false' ? false : null;
const limit = Number(rawLimit);
const windowMs = Number(rawWindow);

if (enabled === null) {
  configurationError = 'FINANCE_API_RATE_LIMIT_ENABLED must be true or false';
} else if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
  configurationError = `FINANCE_API_RATE_LIMIT must be an integer between 1 and ${MAX_LIMIT}`;
} else if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > MAX_WINDOW_MS) {
  configurationError = `FINANCE_API_RATE_WINDOW_MS must be an integer between 1000 and ${MAX_WINDOW_MS}`;
}

const buckets = new Map<string, Bucket>();

export function financeRateLimitConfigurationError(): string | null {
  return configurationError;
}

function evictExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt >= windowMs) buckets.delete(key);
  }
  if (buckets.size < MAX_BUCKETS) return;

  const oldest = [...buckets.entries()]
    .sort((left, right) => left[1].windowStartedAt - right[1].windowStartedAt)
    .slice(0, Math.ceil(MAX_BUCKETS / 10));
  for (const [key] of oldest) buckets.delete(key);
}

export function consumeFinanceRateLimit(key: string, now = Date.now()): RateLimitDecision {
  if (configurationError) {
    return {
      allowed: false,
      enabled: true,
      limit: 0,
      remaining: 0,
      resetAt: Math.ceil((now + DEFAULT_WINDOW_MS) / 1000),
      retryAfterSeconds: Math.ceil(DEFAULT_WINDOW_MS / 1000),
    };
  }
  if (!enabled) {
    return {
      allowed: true,
      enabled: false,
      limit,
      remaining: limit,
      resetAt: Math.ceil((now + windowMs) / 1000),
      retryAfterSeconds: 0,
    };
  }

  evictExpired(now);
  const existing = buckets.get(key);
  const bucket = !existing || now - existing.windowStartedAt >= windowMs
    ? { windowStartedAt: now, count: 0 }
    : existing;
  bucket.count += 1;
  buckets.set(key, bucket);

  const resetAt = Math.ceil((bucket.windowStartedAt + windowMs) / 1000);
  const remaining = Math.max(0, limit - bucket.count);
  const allowed = bucket.count <= limit;
  return {
    allowed,
    enabled: true,
    limit,
    remaining,
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, resetAt - Math.floor(now / 1000)),
  };
}

export function financeRateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  if (!decision.enabled) return {};
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(decision.resetAt),
  };
  if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfterSeconds);
  return headers;
}
