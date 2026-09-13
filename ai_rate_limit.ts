/**
 * Process-local abuse guard for the Central AI Gateway.
 *
 * This is deliberately a single-process pilot boundary. It keys request
 * windows by the authenticated subject, keeps only bounded scalar counters,
 * and never stores tokens, IP addresses, prompts, responses, or provider
 * payloads. A multi-replica deployment needs a shared limiter before it is
 * exposed to public traffic.
 */

export const AI_RATE_LIMIT_CONTRACT = 'solo-empire.ai-rate-limit.v1' as const;

export type AiRateLimitReason = 'allowed' | 'rate_limited' | 'concurrency_limited' | 'configuration_error';

export interface AiRateLimitDecision {
  allowed: boolean;
  reason: AiRateLimitReason;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  activeRequests: number;
  maxConcurrentRequests: number;
  release: () => void;
}

export interface AiRateLimitStatus {
  contract: typeof AI_RATE_LIMIT_CONTRACT;
  enabled: true;
  max_requests_per_minute: number;
  max_concurrent_requests: number;
  window_ms: number;
  active_requests: number;
  tracked_subjects: number;
  configuration_error?: string;
}

export interface AiRateLimiter {
  acquire(subject: string, now?: number): AiRateLimitDecision;
  status(): AiRateLimitStatus;
}

type Bucket = {
  windowStartedAt: number;
  count: number;
};

type Config = {
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  windowMs: number;
  configurationError: string | null;
};

const DEFAULT_MAX_REQUESTS_PER_MINUTE = 30;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 10_000;
const MAX_CONCURRENT_REQUESTS = 100;
const MAX_BUCKETS = 10_000;
const SUBJECT_MAX_LENGTH = 100;

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): { value: number; error: string | null } {
  if (raw === undefined || raw.trim() === '') return { value: fallback, error: null };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return { value: fallback, error: `${label} must be an integer between ${minimum} and ${maximum}` };
  }
  return { value, error: null };
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const requests = parseBoundedInteger(
    env.AI_GATEWAY_MAX_REQUESTS_PER_MINUTE,
    DEFAULT_MAX_REQUESTS_PER_MINUTE,
    1,
    MAX_REQUESTS_PER_MINUTE,
    'AI_GATEWAY_MAX_REQUESTS_PER_MINUTE',
  );
  const concurrency = parseBoundedInteger(
    env.AI_GATEWAY_MAX_CONCURRENT_REQUESTS,
    DEFAULT_MAX_CONCURRENT_REQUESTS,
    1,
    MAX_CONCURRENT_REQUESTS,
    'AI_GATEWAY_MAX_CONCURRENT_REQUESTS',
  );
  return {
    maxRequestsPerMinute: requests.value,
    maxConcurrentRequests: concurrency.value,
    windowMs: WINDOW_MS,
    configurationError: requests.error || concurrency.error,
  };
}

function safeSubject(subject: string): string {
  const value = typeof subject === 'string' ? subject.trim().slice(0, SUBJECT_MAX_LENGTH) : '';
  return value || 'anonymous';
}

function emptyRelease(): void {
  // A denied decision has no active lease. Keeping a no-op release on every
  // decision makes callers safe to clean up from a finally block.
}

class LocalAiRateLimiter implements AiRateLimiter {
  private readonly config: Config;
  private readonly buckets = new Map<string, Bucket>();
  private activeRequests = 0;

  constructor(env: NodeJS.ProcessEnv) {
    this.config = readConfig(env);
  }

  private evictExpired(now: number): void {
    for (const [subject, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= this.config.windowMs) this.buckets.delete(subject);
    }
    if (this.buckets.size < MAX_BUCKETS) return;

    const oldest = [...this.buckets.entries()]
      .sort((left, right) => left[1].windowStartedAt - right[1].windowStartedAt)
      .slice(0, Math.ceil(MAX_BUCKETS / 10));
    for (const [subject] of oldest) this.buckets.delete(subject);
  }

  acquire(subject: string, now = Date.now()): AiRateLimitDecision {
    const resetAtFor = (startedAt: number) => Math.ceil((startedAt + this.config.windowMs) / 1000);
    if (this.config.configurationError) {
      return {
        allowed: false,
        reason: 'configuration_error',
        limit: 0,
        remaining: 0,
        resetAt: Math.ceil((now + this.config.windowMs) / 1000),
        retryAfterSeconds: Math.ceil(this.config.windowMs / 1000),
        activeRequests: this.activeRequests,
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        release: emptyRelease,
      };
    }

    this.evictExpired(now);
    const key = safeSubject(subject);
    const existing = this.buckets.get(key);
    const bucket = !existing || now - existing.windowStartedAt >= this.config.windowMs
      ? { windowStartedAt: now, count: 0 }
      : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);

    const resetAt = resetAtFor(bucket.windowStartedAt);
    const remaining = Math.max(0, this.config.maxRequestsPerMinute - bucket.count);
    if (bucket.count > this.config.maxRequestsPerMinute) {
      return {
        allowed: false,
        reason: 'rate_limited',
        limit: this.config.maxRequestsPerMinute,
        remaining,
        resetAt,
        retryAfterSeconds: Math.max(1, resetAt - Math.floor(now / 1000)),
        activeRequests: this.activeRequests,
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        release: emptyRelease,
      };
    }

    if (this.activeRequests >= this.config.maxConcurrentRequests) {
      return {
        allowed: false,
        reason: 'concurrency_limited',
        limit: this.config.maxRequestsPerMinute,
        remaining,
        resetAt,
        retryAfterSeconds: 1,
        activeRequests: this.activeRequests,
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        release: emptyRelease,
      };
    }

    this.activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    };
    return {
      allowed: true,
      reason: 'allowed',
      limit: this.config.maxRequestsPerMinute,
      remaining,
      resetAt,
      retryAfterSeconds: 0,
      activeRequests: this.activeRequests,
      maxConcurrentRequests: this.config.maxConcurrentRequests,
      release,
    };
  }

  status(): AiRateLimitStatus {
    return {
      contract: AI_RATE_LIMIT_CONTRACT,
      enabled: true,
      max_requests_per_minute: this.config.maxRequestsPerMinute,
      max_concurrent_requests: this.config.maxConcurrentRequests,
      window_ms: this.config.windowMs,
      active_requests: this.activeRequests,
      tracked_subjects: this.buckets.size,
      ...(this.config.configurationError ? { configuration_error: this.config.configurationError } : {}),
    };
  }
}

export function createAiRateLimiter(env: NodeJS.ProcessEnv = process.env): AiRateLimiter {
  return new LocalAiRateLimiter(env);
}

export function aiRateLimitHeaders(decision: AiRateLimitDecision): Record<string, string> {
  if (decision.reason === 'configuration_error') return {};
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(decision.resetAt),
    'X-RateLimit-Concurrent-Limit': String(decision.maxConcurrentRequests),
    'X-RateLimit-Active': String(decision.activeRequests),
  };
  if (!decision.allowed) headers['Retry-After'] = String(decision.retryAfterSeconds);
  return headers;
}
