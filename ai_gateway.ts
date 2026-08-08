import { randomUUID } from 'crypto';

export const AI_GATEWAY_CONTRACT = 'solo-empire.ai-gateway.v1';
export const AI_TELEMETRY_CONTRACT = 'solo-empire.ai-telemetry.v1';

export type AiProfile = 'fast' | 'balanced' | 'quality';
export type AiPrivacyClass = 'public' | 'internal' | 'private' | 'restricted';
export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiGenerateRequest {
  route: string;
  prompt_version: string;
  messages: AiMessage[];
  profile?: AiProfile;
  privacy_class?: AiPrivacyClass;
  token_budget?: number;
  max_output_tokens?: number;
  temperature?: number;
}

export interface AiUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  source: 'provider' | 'estimated' | 'unavailable';
}

export interface AiTelemetryEvent {
  run_id: string;
  route: string;
  prompt_version: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  token_budget: number;
  latency_ms: number;
  estimated_cost_usd: number | null;
  cache_hit: boolean;
  status: 'success' | 'error' | 'budget_exceeded';
  metadata: Record<string, string | number | boolean | null>;
}

export interface AiGenerateResponse {
  contract: typeof AI_GATEWAY_CONTRACT;
  run_id: string;
  status: 'success' | 'budget_exceeded';
  route: string;
  prompt_version: string;
  provider: string;
  model: string;
  content: string;
  output_trust: 'untrusted_model_output';
  finish_reason: string | null;
  usage: AiUsage;
  token_budget: number;
  latency_ms: number;
  estimated_cost_usd: number | null;
}

export interface AiGatewayStatus {
  contract: typeof AI_GATEWAY_CONTRACT;
  configured: boolean;
  provider: string | null;
  adapter: 'openai-compatible' | 'none';
  base_url_configured: boolean;
  api_key_configured: boolean;
  models: Record<AiProfile, string | null>;
  limits: {
    max_context_chars: number;
    max_output_tokens: number;
    default_token_budget: number;
    timeout_ms: number;
  };
  reason?: string;
}

export class AiGatewayError extends Error {
  readonly status: number;
  readonly telemetry?: AiTelemetryEvent;

  constructor(status: number, message: string, telemetry?: AiTelemetryEvent) {
    super(message);
    this.name = 'AiGatewayError';
    this.status = status;
    this.telemetry = telemetry;
  }
}

interface GatewayConfig {
  provider: 'openai-compatible';
  providerName: string;
  baseUrl: URL;
  apiKey: string;
  models: Record<AiProfile, string>;
  maxContextChars: number;
  maxOutputTokens: number;
  defaultTokenBudget: number;
  timeoutMs: number;
  inputRatePer1k: number | null;
  outputRatePer1k: number | null;
}

const PROFILE_DEFAULT_OUTPUT: Record<AiProfile, number> = {
  fast: 512,
  balanced: 1024,
  quality: 2048,
};

const PRIVACY_CLASSES = new Set<AiPrivacyClass>(['public', 'internal', 'private', 'restricted']);
const PROFILES = new Set<AiProfile>(['fast', 'balanced', 'quality']);

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function nonNegativeRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeName(value: string | undefined, fallback: string): string {
  const candidate = (value || fallback).trim();
  return /^[A-Za-z0-9_.:/-]{1,100}$/.test(candidate) ? candidate : fallback;
}

function validateBaseUrl(raw: string, env: NodeJS.ProcessEnv): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AiGatewayError(503, 'AI gateway provider URL is invalid');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AiGatewayError(503, 'AI gateway provider URL contains forbidden credentials or query data');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && env.NODE_ENV !== 'production')) {
    throw new AiGatewayError(503, 'AI gateway provider URL must use HTTPS');
  }
  return parsed;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = (env.AI_GATEWAY_PROVIDER || '').trim();
  if (provider !== 'openai-compatible') {
    throw new AiGatewayError(503, 'AI gateway provider is not configured');
  }

  const rawBaseUrl = (env.AI_GATEWAY_BASE_URL || '').trim();
  const apiKey = (env.AI_GATEWAY_API_KEY || '').trim();
  if (!rawBaseUrl) throw new AiGatewayError(503, 'AI gateway provider URL is not configured');
  const baseUrl = validateBaseUrl(rawBaseUrl, env);
  const local = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === '::1';
  if (!apiKey && (!local || env.NODE_ENV === 'production')) {
    throw new AiGatewayError(503, 'AI gateway provider credential is not configured');
  }

  const defaultModel = safeName(env.AI_GATEWAY_MODEL, '');
  const models = {
    fast: safeName(env.AI_GATEWAY_MODEL_FAST, defaultModel),
    balanced: safeName(env.AI_GATEWAY_MODEL_BALANCED, defaultModel),
    quality: safeName(env.AI_GATEWAY_MODEL_QUALITY, defaultModel),
  };
  if (!models.fast || !models.balanced || !models.quality) {
    throw new AiGatewayError(503, 'AI gateway model mapping is not configured');
  }

  return {
    provider: 'openai-compatible',
    providerName: safeName(env.AI_GATEWAY_PROVIDER_NAME, 'openai-compatible'),
    baseUrl,
    apiKey,
    models,
    maxContextChars: boundedInt(env.AI_GATEWAY_MAX_CONTEXT_CHARS, 48_000, 1_024, 200_000),
    maxOutputTokens: boundedInt(env.AI_GATEWAY_MAX_OUTPUT_TOKENS, 4_096, 128, 16_384),
    defaultTokenBudget: boundedInt(env.AI_GATEWAY_DEFAULT_TOKEN_BUDGET, 4_096, 256, 32_768),
    timeoutMs: boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    inputRatePer1k: nonNegativeRate(env.AI_GATEWAY_INPUT_USD_PER_1K),
    outputRatePer1k: nonNegativeRate(env.AI_GATEWAY_OUTPUT_USD_PER_1K),
  };
}

export function getAiGatewayStatus(env: NodeJS.ProcessEnv = process.env): AiGatewayStatus {
  const common = {
    contract: AI_GATEWAY_CONTRACT as typeof AI_GATEWAY_CONTRACT,
    adapter: 'none' as const,
    base_url_configured: Boolean(env.AI_GATEWAY_BASE_URL),
    api_key_configured: Boolean(env.AI_GATEWAY_API_KEY),
    models: {
      fast: env.AI_GATEWAY_MODEL_FAST || env.AI_GATEWAY_MODEL || null,
      balanced: env.AI_GATEWAY_MODEL_BALANCED || env.AI_GATEWAY_MODEL || null,
      quality: env.AI_GATEWAY_MODEL_QUALITY || env.AI_GATEWAY_MODEL || null,
    },
    limits: {
      max_context_chars: boundedInt(env.AI_GATEWAY_MAX_CONTEXT_CHARS, 48_000, 1_024, 200_000),
      max_output_tokens: boundedInt(env.AI_GATEWAY_MAX_OUTPUT_TOKENS, 4_096, 128, 16_384),
      default_token_budget: boundedInt(env.AI_GATEWAY_DEFAULT_TOKEN_BUDGET, 4_096, 256, 32_768),
      timeout_ms: boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    },
  };
  try {
    const config = readConfig(env);
    return {
      ...common,
      configured: true,
      provider: config.providerName,
      adapter: 'openai-compatible',
    };
  } catch (error) {
    return {
      ...common,
      configured: false,
      provider: env.AI_GATEWAY_PROVIDER || null,
      reason: error instanceof AiGatewayError ? error.message : 'AI gateway configuration is invalid',
    };
  }
}

function validateRequest(input: unknown, config: GatewayConfig): Required<Pick<AiGenerateRequest, 'route' | 'prompt_version' | 'messages'>> & {
  profile: AiProfile;
  privacyClass: AiPrivacyClass;
  tokenBudget: number;
  maxOutputTokens: number;
  temperature: number;
} {
  if (!input || typeof input !== 'object') throw new AiGatewayError(400, 'Request body must be a JSON object');
  const value = input as Record<string, unknown>;
  const route = typeof value.route === 'string' ? value.route.trim() : '';
  const promptVersion = typeof value.prompt_version === 'string' ? value.prompt_version.trim() : '';
  if (!/^[A-Za-z0-9_.:/-]{1,64}$/.test(route)) throw new AiGatewayError(400, 'route is required and must be a safe identifier');
  if (!/^[A-Za-z0-9_.:/-]{1,64}$/.test(promptVersion)) throw new AiGatewayError(400, 'prompt_version is required and must be a safe identifier');

  const profile = (typeof value.profile === 'string' ? value.profile : 'balanced') as AiProfile;
  if (!PROFILES.has(profile)) throw new AiGatewayError(400, 'profile must be fast, balanced, or quality');
  const privacyClass = (typeof value.privacy_class === 'string' ? value.privacy_class : 'internal') as AiPrivacyClass;
  if (!PRIVACY_CLASSES.has(privacyClass)) throw new AiGatewayError(400, 'privacy_class is invalid');
  if (privacyClass === 'private' || privacyClass === 'restricted') {
    throw new AiGatewayError(403, 'Hosted AI generation is disabled for private or restricted data');
  }

  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) {
    throw new AiGatewayError(400, 'messages must contain between 1 and 40 items');
  }
  const messages = value.messages.map((item, index) => {
    if (!item || typeof item !== 'object') throw new AiGatewayError(400, `messages[${index}] must be an object`);
    const message = item as Record<string, unknown>;
    const role = message.role;
    const content = message.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw new AiGatewayError(400, `messages[${index}].role is invalid`);
    if (typeof content !== 'string' || content.trim() === '' || content.length > config.maxContextChars) {
      throw new AiGatewayError(400, `messages[${index}].content is empty or too large`);
    }
    return { role, content } as AiMessage;
  });
  if (!messages.some((message) => message.role === 'user')) throw new AiGatewayError(400, 'messages must contain a user message');
  const contextChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (contextChars > config.maxContextChars) throw new AiGatewayError(400, 'message context exceeds the gateway limit');

  const tokenBudget = value.token_budget === undefined ? config.defaultTokenBudget : Number(value.token_budget);
  if (!Number.isInteger(tokenBudget) || tokenBudget < 256 || tokenBudget > config.defaultTokenBudget) {
    throw new AiGatewayError(400, `token_budget must be an integer between 256 and ${config.defaultTokenBudget}`);
  }
  const requestedOutput = value.max_output_tokens === undefined ? PROFILE_DEFAULT_OUTPUT[profile] : Number(value.max_output_tokens);
  const maxOutputTokens = Math.min(requestedOutput, config.maxOutputTokens);
  if (!Number.isInteger(requestedOutput) || requestedOutput < 1 || requestedOutput > config.maxOutputTokens) {
    throw new AiGatewayError(400, `max_output_tokens must be an integer between 1 and ${config.maxOutputTokens}`);
  }
  const temperature = value.temperature === undefined ? 0.2 : Number(value.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new AiGatewayError(400, 'temperature must be between 0 and 2');
  const estimatedInputTokens = Math.ceil(contextChars / 4) + messages.length * 4;
  if (estimatedInputTokens + maxOutputTokens > tokenBudget) throw new AiGatewayError(400, 'estimated input and output exceed token_budget');

  return { route, prompt_version: promptVersion, messages, profile, privacyClass, tokenBudget, maxOutputTokens, temperature };
}

function endpoint(baseUrl: URL): URL {
  const base = baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`;
  return new URL('chat/completions', base);
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function telemetryForError(runId: string, request: { route: string; prompt_version: string; tokenBudget: number }, provider: string | null, model: string | null, latencyMs: number, status: 'error' = 'error', errorClass?: string): AiTelemetryEvent {
  return {
    run_id: runId,
    route: request.route,
    prompt_version: request.prompt_version,
    provider,
    model,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    token_budget: request.tokenBudget,
    latency_ms: latencyMs,
    estimated_cost_usd: null,
    cache_hit: false,
    status,
    metadata: { contract: AI_GATEWAY_CONTRACT, error_class: errorClass || 'provider_error' },
  };
}

export async function generateAi(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{ response: AiGenerateResponse; telemetry: AiTelemetryEvent }> {
  const runId = randomUUID();
  const started = performance.now();
  let config: GatewayConfig;
  try {
    config = readConfig(env);
  } catch (error) {
    const message = error instanceof AiGatewayError ? error.message : 'AI gateway configuration is invalid';
    throw new AiGatewayError(503, message, telemetryForError(runId, { route: 'unknown', prompt_version: 'unknown', tokenBudget: 0 }, null, null, performance.now() - started, 'error', 'not_configured'));
  }
  const request = validateRequest(input, config);
  const model = config.models[request.profile];
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let providerResponse: Response;
  try {
    providerResponse = await fetch(endpoint(config.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model, messages: request.messages, temperature: request.temperature, max_tokens: request.maxOutputTokens, stream: false }),
    });
  } catch (error) {
    const latencyMs = Number((performance.now() - started).toFixed(3));
    const errorClass = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error';
    throw new AiGatewayError(errorClass === 'timeout' ? 504 : 502, `AI provider ${errorClass}`, telemetryForError(runId, request, config.providerName, model, latencyMs, 'error', errorClass));
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Number((performance.now() - started).toFixed(3));
  if (!providerResponse.ok) {
    const errorClass = providerResponse.status === 429 ? 'rate_limited' : providerResponse.status === 401 || providerResponse.status === 403 ? 'provider_auth' : 'provider_rejected';
    const status = providerResponse.status === 429 ? 429 : 502;
    throw new AiGatewayError(status, `AI provider ${errorClass}`, telemetryForError(runId, request, config.providerName, model, latencyMs, 'error', errorClass));
  }

  let payload: any;
  try {
    payload = await providerResponse.json();
  } catch {
    throw new AiGatewayError(502, 'AI provider returned invalid JSON', telemetryForError(runId, request, config.providerName, model, latencyMs, 'error', 'invalid_json'));
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new AiGatewayError(502, 'AI provider response did not contain text content', telemetryForError(runId, request, config.providerName, model, latencyMs, 'error', 'invalid_response'));
  }
  const inputTokens = integerOrNull(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
  const outputTokens = integerOrNull(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
  const totalTokens = integerOrNull(payload?.usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const usage: AiUsage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, source: totalTokens === null ? 'unavailable' : 'provider' };
  const estimatedCost = inputTokens !== null && outputTokens !== null && (config.inputRatePer1k !== null || config.outputRatePer1k !== null)
    ? Number(((inputTokens * (config.inputRatePer1k || 0) + outputTokens * (config.outputRatePer1k || 0)) / 1000).toFixed(8))
    : null;
  const status = totalTokens !== null && totalTokens > request.tokenBudget ? 'budget_exceeded' : 'success';
  const telemetry: AiTelemetryEvent = {
    run_id: runId,
    route: request.route,
    prompt_version: request.prompt_version,
    provider: config.providerName,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    token_budget: request.tokenBudget,
    latency_ms: latencyMs,
    estimated_cost_usd: estimatedCost,
    cache_hit: false,
    status,
    metadata: { contract: AI_GATEWAY_CONTRACT, profile: request.profile, privacy_class: request.privacyClass, usage_source: usage.source },
  };
  return {
    response: {
      contract: AI_GATEWAY_CONTRACT,
      run_id: runId,
      status,
      route: request.route,
      prompt_version: request.prompt_version,
      provider: config.providerName,
      model,
      content,
      output_trust: 'untrusted_model_output',
      finish_reason: typeof payload?.choices?.[0]?.finish_reason === 'string' ? payload.choices[0].finish_reason : null,
      usage,
      token_budget: request.tokenBudget,
      latency_ms: latencyMs,
      estimated_cost_usd: estimatedCost,
    },
    telemetry,
  };
}
