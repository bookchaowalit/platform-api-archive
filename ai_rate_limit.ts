/**
 * Process-local abuse guard for the Central AI Gateway.
 *
 * This is deliberately a single-process pilot boundary. It keys request
 * windows by the authenticated subject, keeps only bounded scalar counters,
 * and never stores tokens, IP addresses, prompts, responses, or provider
 * payloads. A multi-replica deployment needs a shared limiter before it is
 * exposed to public traffic.
 *
 * AI_GATEWAY_SUBJECT_LIMITS_JSON optionally overrides the per-minute window
 * and adds a per-subject concurrency cap for named subjects, e.g.
 * {"ev3-web":{"max_requests_per_minute":120,"max_concurrent_requests":8}}.
 * The process-wide AI_GATEWAY_MAX_CONCURRENT_REQUESTS cap always applies.
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
  subject_overrides: number;
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

type SubjectLimit = {
  maxRequestsPerMinute: number | null;
  maxConcurrentRequests: number | null;
};

type Config = {
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  windowMs: number;
  subjectLimits: Map<string, SubjectLimit>;
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

const SUBJECT_LIMIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function optionalLimit(value: unknown, maximum: number, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function parseSubjectLimits(raw: string | undefined): { limits: Map<string, SubjectLimit>; error: string | null } {
  const limits = new Map<string, SubjectLimit>();
  if (raw === undefined || raw.trim() === '') return { limits, error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length > 100) {
      throw new Error('AI_GATEWAY_SUBJECT_LIMITS_JSON must be an object with at most 100 subjects');
    }
    for (const [subject, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!SUBJECT_LIMIT_PATTERN.test(subject) || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('AI_GATEWAY_SUBJECT_LIMITS_JSON has an invalid subject entry');
      }
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).some((key) => key !== 'max_requests_per_minute' && key !== 'max_concurrent_requests')) {
        throw new Error('AI_GATEWAY_SUBJECT_LIMITS_JSON has an unknown limit field');
      }
      limits.set(subject, {
        maxRequestsPerMinute: optionalLimit(entry.max_requests_per_minute, MAX_REQUESTS_PER_MINUTE, 'AI_GATEWAY_SUBJECT_LIMITS_JSON max_requests_per_minute'),
        maxConcurrentRequests: optionalLimit(entry.max_concurrent_requests, MAX_CONCURRENT_REQUESTS, 'AI_GATEWAY_SUBJECT_LIMITS_JSON max_concurrent_requests'),
      });
    }
    return { limits, error: null };
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('AI_GATEWAY_SUBJECT_LIMITS_JSON')
      ? error.message
      : 'AI_GATEWAY_SUBJECT_LIMITS_JSON must be valid JSON';
    return { limits: new Map(), error: message };
  }
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
  const subjects = parseSubjectLimits(env.AI_GATEWAY_SUBJECT_LIMITS_JSON);
  return {
    maxRequestsPerMinute: requests.value,
    maxConcurrentRequests: concurrency.value,
    windowMs: WINDOW_MS,
    subjectLimits: subjects.limits,
    configurationError: requests.error || concurrency.error || subjects.error,
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
  private readonly activeBySubject = new Map<string, number>();
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
    const subjectLimit = this.config.subjectLimits.get(key);
    const maxRequestsPerMinute = subjectLimit?.maxRequestsPerMinute ?? this.config.maxRequestsPerMinute;
    const subjectActive = this.activeBySubject.get(key) || 0;
    const existing = this.buckets.get(key);
    const bucket = !existing || now - existing.windowStartedAt >= this.config.windowMs
      ? { windowStartedAt: now, count: 0 }
      : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);

    const resetAt = resetAtFor(bucket.windowStartedAt);
    const remaining = Math.max(0, maxRequestsPerMinute - bucket.count);
    if (bucket.count > maxRequestsPerMinute) {
      return {
        allowed: false,
        reason: 'rate_limited',
        limit: maxRequestsPerMinute,
        remaining,
        resetAt,
        retryAfterSeconds: Math.max(1, resetAt - Math.floor(now / 1000)),
        activeRequests: this.activeRequests,
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        release: emptyRelease,
      };
    }

    const subjectConcurrency = subjectLimit?.maxConcurrentRequests ?? null;
    if (this.activeRequests >= this.config.maxConcurrentRequests
      || (subjectConcurrency !== null && subjectActive >= subjectConcurrency)) {
      return {
        allowed: false,
        reason: 'concurrency_limited',
        limit: maxRequestsPerMinute,
        remaining,
        resetAt,
        retryAfterSeconds: 1,
        activeRequests: this.activeRequests,
        maxConcurrentRequests: subjectConcurrency ?? this.config.maxConcurrentRequests,
        release: emptyRelease,
      };
    }

    this.activeRequests += 1;
    this.activeBySubject.set(key, subjectActive + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      const current = (this.activeBySubject.get(key) || 1) - 1;
      if (current > 0) this.activeBySubject.set(key, current);
      else this.activeBySubject.delete(key);
    };
    return {
      allowed: true,
      reason: 'allowed',
      limit: maxRequestsPerMinute,
      remaining,
      resetAt,
      retryAfterSeconds: 0,
      activeRequests: this.activeRequests,
      maxConcurrentRequests: subjectConcurrency ?? this.config.maxConcurrentRequests,
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
      subject_overrides: this.config.subjectLimits.size,
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
