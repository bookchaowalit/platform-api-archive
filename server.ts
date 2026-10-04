import { createServer } from 'http';
import { execFile } from 'child_process';
import { getDb, initDb, closeDb } from '../mcp-server/src/db.js';
import { fileURLToPath, URL } from 'url';
import { promisify } from 'util';
import { join } from 'path';
import { EXTERNAL_APP_REGISTRY, EXTERNAL_INTEGRATIONS, sanitizeIntegrationHealth } from './integrations.js';
import { BUILDING_BLOCK_FILTERS, buildingBlocksResponse, type BuildingBlockFilter } from './building_blocks.js';
import { PlatformInputError } from './platform/errors.js';
import { invoicePreview, taxQuote } from './platform/thai_tax.js';
import { presignFile, r2ConfigFromEnv } from './platform/files.js';
import { sendEmail } from './platform/email.js';
import { identityConfigFromEnv, verifySessionRequest, type IdentityConfig } from './platform/identity.js';
import { getLineEventExternalId, verifyLineSignature, type LineWebhookEvent } from './line.js';
import { verifyStripeSignature } from './stripe.js';
import { AiGatewayError, generateAi, getAiGatewayStatus, type AiTelemetryEvent } from './ai_gateway.js';
import { AiBudgetError, createAiBudgetGuard, getAiBudgetStatus } from './ai_budget.js';
import { aiRateLimitHeaders, createAiRateLimiter } from './ai_rate_limit.js';
import { startTelemetry, withRequestSpan } from './telemetry.js';
import { financeApiResponse } from './finance.js';
import { newFinanceApiRequestId, recordFinanceApiAudit } from './audit.js';
import { authConfigurationError, authConfigurationPresent, requireAuth, type AuthResult } from './auth.js';
import {
  consumeFinanceRateLimit,
  financeRateLimitConfigurationError,
  financeRateLimitHeaders,
} from './rate_limit.js';

startTelemetry();

const PORT = parseInt(process.env.PORT || '3001', 10);
// Local development binds to loopback. A hosted deployment must explicitly
// opt in to a public bind behind its authenticated ingress.
const API_HOST = process.env.API_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const API_TOKEN = process.env.API_TOKEN || '';  // Bearer token for write routes
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '1048576'); // 1MB default
const AI_RATE_LIMITER = createAiRateLimiter(process.env);
const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PYTHON_WRAPPER = join(REPO_ROOT, 'infra', 'scripts', 'setup', 'run-python3.sh');
const INTEGRATION_HEALTH_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'integration_health.py');
const EXTERNAL_DISCOVERY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'discover_external_apps.py');
const SENTRY_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'sentry_readonly.py');
const POSTHOG_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'posthog_readonly.py');
const SLACK_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'slack_readonly.py');
const NOTION_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'notion_readonly.py');
const ASANA_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'asana_readonly.py');
const LINEAR_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'linear_readonly.py');
const DISCORD_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'discord_readonly.py');
const WHATSAPP_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'whatsapp_business_readonly.py');
const MICROSOFT_GRAPH_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'microsoft_graph_readonly.py');
const ZOOM_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'zoom_readonly.py');
const MONDAY_READONLY_SCRIPT = join(REPO_ROOT, 'infra', 'scripts', 'sync', 'monday_readonly.py');
const INTEGRATION_HEALTH_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.INTEGRATION_HEALTH_TIMEOUT_MS || 120000), 1000),
  300000,
);
const EXTERNAL_DISCOVERY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.EXTERNAL_DISCOVERY_TIMEOUT_MS || 180000), 1000),
  300000,
);
const SENTRY_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.SENTRY_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const POSTHOG_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.POSTHOG_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const SLACK_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.SLACK_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const NOTION_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.NOTION_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const ASANA_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.ASANA_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const LINEAR_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.LINEAR_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const DISCORD_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.DISCORD_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const WHATSAPP_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.WHATSAPP_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const MICROSOFT_GRAPH_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.MICROSOFT_GRAPH_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const ZOOM_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.ZOOM_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);
const MONDAY_READONLY_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.MONDAY_READONLY_TIMEOUT_MS || 30000), 1000),
  120000,
);

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// CORS headers — restrict origin in production
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
  'Content-Type': 'application/json; charset=utf-8',
};

function getCorsHeaders(req: any): Record<string, string> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return { ...corsHeaders };
  return { ...corsHeaders, 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
}

/**
 * Validate URL format.
 */
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function sendJson(
  res: any,
  data: any,
  status = 200,
  req?: any,
  requestId?: string,
  extraHeaders?: Record<string, string>,
) {
  const headers = req
    ? getCorsHeaders(req)
    // Internal callers do not have a browser origin. Do not turn an omitted
    // request object into a wildcard CORS response.
    : { ...corsHeaders };
  if (requestId) headers['X-Request-ID'] = requestId;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendAuthFailure(res: any, req: any, auth: AuthResult) {
  const status = auth.status || 401;
  return sendJson(
    res,
    { error: status === 403 ? 'Forbidden' : 'Unauthorized', message: auth.error },
    status,
    req,
  );
}

function recordAiTelemetry(db: any, event: AiTelemetryEvent): void {
  db.prepare(`
    INSERT INTO ai_run_telemetry
      (run_id, route, prompt_version, provider, model, input_tokens,
       output_tokens, total_tokens, token_budget, latency_ms,
       estimated_cost_usd, cache_hit, status, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      route=excluded.route,
      prompt_version=excluded.prompt_version,
      provider=excluded.provider,
      model=excluded.model,
      input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens,
      total_tokens=excluded.total_tokens,
      token_budget=excluded.token_budget,
      latency_ms=excluded.latency_ms,
      estimated_cost_usd=excluded.estimated_cost_usd,
      cache_hit=excluded.cache_hit,
      status=excluded.status,
      metadata_json=excluded.metadata_json
  `).run(
    event.run_id,
    event.route,
    event.prompt_version,
    event.provider,
    event.model,
    event.input_tokens,
    event.output_tokens,
    event.total_tokens,
    event.token_budget,
    event.latency_ms,
    event.estimated_cost_usd,
    event.cache_hit ? 1 : 0,
    event.status,
    JSON.stringify(event.metadata),
  );
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new HttpError(413, `Request body too large (max ${MAX_BODY_SIZE} bytes)`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseRawBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_BODY_SIZE) {
        fail(new HttpError(413, `Request body too large (max ${MAX_BODY_SIZE} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(part);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

async function runIntegrationHealth(offline: boolean) {
  const args = [INTEGRATION_HEALTH_SCRIPT, '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: INTEGRATION_HEALTH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return sanitizeIntegrationHealth(JSON.parse(result.stdout));
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[integration-health] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Integration health check timed out');
    }
    throw new HttpError(502, 'Integration health check unavailable');
  }
}

async function runExternalDiscovery(source: 'apis-guru' | 'mcp-registry' | 'all', limit: number, offline: boolean) {
  const args = [EXTERNAL_DISCOVERY_SCRIPT, '--source', source, '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: EXTERNAL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    // A partial discovery run exits non-zero by contract but still returns a
    // safe JSON report. Preserve that report for callers instead of hiding it.
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // Fall through to the bounded error response below.
      }
    }
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[external-discovery] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'External catalog discovery timed out');
    }
    throw new HttpError(502, 'External catalog discovery unavailable');
  }
}

async function runSentryIssues(limit: number, offline: boolean) {
  const args = [SENTRY_READONLY_SCRIPT, '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: SENTRY_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[sentry-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Sentry read-only API timed out');
    }
    throw new HttpError(502, 'Sentry read-only API unavailable');
  }
}

async function runPostHogInsights(limit: number, offline: boolean) {
  const args = [POSTHOG_READONLY_SCRIPT, '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: POSTHOG_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[posthog-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'PostHog read-only API timed out');
    }
    throw new HttpError(502, 'PostHog read-only API unavailable');
  }
}

async function runSlackChannels(limit: number, offline: boolean) {
  const args = [SLACK_READONLY_SCRIPT, '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: SLACK_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[slack-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Slack read-only API timed out');
    }
    throw new HttpError(502, 'Slack read-only API unavailable');
  }
}

async function runNotionSearch(limit: number, query: string, offline: boolean) {
  const args = [NOTION_READONLY_SCRIPT, '--limit', String(limit), '--json'];
  if (query) args.push('--query', query);
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: NOTION_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[notion-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Notion read-only API timed out');
    }
    throw new HttpError(502, 'Notion read-only API unavailable');
  }
}

async function runAsana(resource: 'workspaces' | 'projects', limit: number, workspace: string, offline: boolean) {
  const args = [ASANA_READONLY_SCRIPT, '--resource', resource, '--limit', String(limit), '--json'];
  if (workspace) args.push('--workspace', workspace);
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: ASANA_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[asana-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Asana read-only API timed out');
    }
    throw new HttpError(502, 'Asana read-only API unavailable');
  }
}

async function runLinear(resource: 'teams' | 'projects', limit: number, offline: boolean) {
  const args = [LINEAR_READONLY_SCRIPT, '--resource', resource, '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: LINEAR_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[linear-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Linear read-only API timed out');
    }
    throw new HttpError(502, 'Linear read-only API unavailable');
  }
}

async function runDiscordGuilds(limit: number, offline: boolean) {
  const args = [DISCORD_READONLY_SCRIPT, '--resource', 'guilds', '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: DISCORD_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[discord-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Discord read-only API timed out');
    }
    throw new HttpError(502, 'Discord read-only API unavailable');
  }
}

async function runWhatsAppPhoneNumbers(limit: number, offline: boolean) {
  const args = [WHATSAPP_READONLY_SCRIPT, '--resource', 'phone-numbers', '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: WHATSAPP_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[whatsapp-business-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'WhatsApp Business read-only API timed out');
    }
    throw new HttpError(502, 'WhatsApp Business read-only API unavailable');
  }
}

async function runMicrosoftGraphProfile(offline: boolean) {
  const args = [MICROSOFT_GRAPH_READONLY_SCRIPT, '--resource', 'me', '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: MICROSOFT_GRAPH_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[microsoft-graph-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Microsoft Graph read-only API timed out');
    }
    throw new HttpError(502, 'Microsoft Graph read-only API unavailable');
  }
}

async function runZoomProfile(offline: boolean) {
  const args = [ZOOM_READONLY_SCRIPT, '--resource', 'me', '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: ZOOM_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[zoom-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'Zoom read-only API timed out');
    }
    throw new HttpError(502, 'Zoom read-only API unavailable');
  }
}

async function runMondayBoards(limit: number, offline: boolean) {
  const args = [MONDAY_READONLY_SCRIPT, '--resource', 'boards', '--limit', String(limit), '--json'];
  if (offline) args.push('--offline');

  try {
    const result = await execFileAsync(PYTHON_WRAPPER, args, {
      cwd: REPO_ROOT,
      env: process.env,
      timeout: MONDAY_READONLY_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error: any) {
    const errorClass = error?.code === 'ETIMEDOUT' ? 'timeout' : (error?.name || 'Error');
    console.error(`[monday-readonly] ${errorClass}`);
    if (error?.code === 'ETIMEDOUT') {
      throw new HttpError(504, 'monday.com read-only API timed out');
    }
    throw new HttpError(502, 'monday.com read-only API unavailable');
  }
}

// =====================================================
// ROUTES
// =====================================================

async function handleRequest(req: any, res: any) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  return withRequestSpan(
    `${req.method || 'GET'} ${url.pathname}`,
    { 'http.method': req.method || 'GET', 'http.route': url.pathname },
    () => handleRequestInner(req, res, url),
  );
}

async function handleRequestInner(req: any, res: any, url: URL) {
  const path = url.pathname;
  const method = req.method || 'GET';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, getCorsHeaders(req));
    res.end();
    return;
  }

  const db = await getDb();

  try {
    // Central AI Gateway: all hosted generation is authenticated, bounded,
    // provider-neutral, and opt-in. Prompt/response bodies never enter telemetry.
    if (path === '/api/ai/status' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      return sendJson(
        res,
        { ...getAiGatewayStatus(), budget: getAiBudgetStatus(db), rate_limit: AI_RATE_LIMITER.status() },
        200,
        req,
      );
    }

    if (path === '/api/ai/generate' && method === 'POST') {
      const auth = requireAuth(req, 'ai:generate');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const body = await parseBody(req);
      const rateLimit = AI_RATE_LIMITER.acquire(auth.subject || 'anonymous');
      if (!rateLimit.allowed) {
        const status = rateLimit.reason === 'configuration_error' ? 503 : 429;
        return sendJson(
          res,
          {
            error: status === 429 ? 'Too Many Requests' : 'AI gateway rate limiter is unavailable',
            code: rateLimit.reason,
            retry_after_seconds: rateLimit.retryAfterSeconds,
          },
          status,
          req,
          undefined,
          aiRateLimitHeaders(rateLimit),
        );
      }
      try {
        const result = await generateAi(body, process.env, {
          budgetGuard: createAiBudgetGuard(db),
          recordTelemetry: (event) => recordAiTelemetry(db, event),
        });
        return sendJson(res, result.response, 200, req);
      } catch (error) {
        if (error instanceof AiGatewayError && error.telemetry && (error.telemetry.estimated_cost_usd === 0 || error.telemetry.provider === null)) {
          recordAiTelemetry(db, error.telemetry);
        }
        if (error instanceof AiGatewayError) {
          throw new HttpError(error.status, error.message);
        }
        if (error instanceof AiBudgetError) {
          throw new HttpError(503, 'AI monthly budget guard is unavailable');
        }
        throw error;
      } finally {
        rateLimit.release();
      }
    }

    // BookFinance API v1: authenticated read-only facade over the finance
    // control-plane tables. Frontends consume this boundary; scrapers and
    // data products must not write to it or access SQLite directly.
    if (path === '/api/finance/v1' || path.startsWith('/api/finance/v1/')) {
      const requestId = newFinanceApiRequestId();
      const auth = requireAuth(req, 'finance:read');
      const rateLimit = consumeFinanceRateLimit(auth.subject || 'anonymous');
      const rateLimitHeaders = financeRateLimitHeaders(rateLimit);
      if (!rateLimit.allowed) {
        recordFinanceApiAudit(db, requestId, {
          method,
          route: path,
          status: 429,
          authorized: auth.authorized,
          subject: auth.subject,
          scopes: auth.scopes,
          requiredScope: 'finance:read',
          queryKeys: [...url.searchParams.keys()],
        });
        return sendJson(
          res,
          {
            error: 'Too Many Requests',
            schema_version: 'finance.v1',
            retry_after_seconds: rateLimit.retryAfterSeconds,
          },
          429,
          req,
          requestId,
          rateLimitHeaders,
        );
      }
      if (!auth.authorized) {
        recordFinanceApiAudit(db, requestId, {
          method,
          route: path,
          status: auth.status || 401,
          authorized: false,
          subject: auth.subject,
          scopes: auth.scopes,
          requiredScope: 'finance:read',
          queryKeys: [...url.searchParams.keys()],
        });
        return sendJson(
          res,
          { error: auth.status === 403 ? 'Forbidden' : 'Unauthorized', message: auth.error },
          auth.status || 401,
          req,
          requestId,
          rateLimitHeaders,
        );
      }
      try {
        const result = financeApiResponse(db, url, method);
        if (!result) {
          recordFinanceApiAudit(db, requestId, {
            method,
            route: path,
            status: 404,
            authorized: true,
            subject: auth.subject,
            scopes: auth.scopes,
            requiredScope: 'finance:read',
            queryKeys: [...url.searchParams.keys()],
          });
          return sendJson(res, { error: 'BookFinance API route not found' }, 404, req, requestId, rateLimitHeaders);
        }
        recordFinanceApiAudit(db, requestId, {
          method,
          route: path,
          status: result.status,
          authorized: true,
          subject: auth.subject,
          scopes: auth.scopes,
          requiredScope: 'finance:read',
          queryKeys: [...url.searchParams.keys()],
        });
        return sendJson(res, result.body, result.status, req, requestId, rateLimitHeaders);
      } catch (error) {
        recordFinanceApiAudit(db, requestId, {
          method,
          route: path,
          status: 500,
          authorized: true,
          subject: auth.subject,
          scopes: auth.scopes,
          requiredScope: 'finance:read',
          queryKeys: [...url.searchParams.keys()],
        });
        throw error;
      }
    }

    // =====================================================
    // PUBLIC API: สำหรับ landing page ดึงข้อมูลไปแสดง
    // =====================================================

    // GET /api/profile - ดึงข้อมูล profile
    if (path === '/api/profile' && method === 'GET') {
      const profile = db.prepare('SELECT id, name, title, bio, tagline, location, website, avatar_url, header_image_url FROM profile LIMIT 1').get();
      const socialLinks = db.prepare('SELECT id, platform, url, username, display_name, description, is_primary FROM social_links WHERE is_active = 1 ORDER BY sort_order').all();
      return sendJson(res, { profile, socialLinks }, 200, req);
    }

    // GET /api/skills - ดึง skills สำหรับแสดงใน portfolio
    if (path === '/api/skills' && method === 'GET') {
      const category = url.searchParams.get('category');
      const status = url.searchParams.get('status');

      let query = `
        SELECT s.name, s.slug, s.description, s.level, s.status, s.progress_percent,
               sc.name as category_name, sc.slug as category_slug, sc.icon, sc.color
        FROM skills s
        LEFT JOIN skill_categories sc ON s.category_id = sc.id
        WHERE 1=1
      `;
      const args: any[] = [];

      if (category) { query += ' AND sc.slug = ?'; args.push(category); }
      if (status) { query += ' AND s.status = ?'; args.push(status); }

      query += ' ORDER BY s.priority ASC, s.progress_percent DESC';

      const skills = db.prepare(query).all(...args);
      return sendJson(res, { skills }, 200, req);
    }

    // GET /api/skills/:slug - ดึง skill เดียว
    if (path.match(/^\/api\/skills\/[\w-]+$/) && method === 'GET') {
      const slug = path.split('/').pop();
      const skill = db.prepare(`
        SELECT s.id, s.name, s.slug, s.description, s.level, s.target_level,
               s.status, s.progress_percent, s.hours_invested,
               s.started_at, s.target_completion_date, s.last_practiced,
               sc.name as category_name, sc.slug as category_slug
        FROM skills s
        LEFT JOIN skill_categories sc ON s.category_id = sc.id
        WHERE s.slug = ?
      `).get(slug);

      if (!skill) return sendJson(res, { error: 'Not found' }, 404, req);
      return sendJson(res, { skill }, 200, req);
    }

    // GET /api/assets - ดึง assets สำหรับแสดง
    if (path === '/api/assets' && method === 'GET') {
      const type = url.searchParams.get('type');
      const status = url.searchParams.get('status');

      // Public assets are limited to launched/maintained records. Financial
      // valuation and revenue columns remain internal to the control plane.
      let query = "SELECT id, name, type, description, url, platform, status, views, subscribers FROM assets WHERE status IN ('active', 'maintenance')";
      const args: any[] = [];

      if (type) { query += ' AND type = ?'; args.push(type); }
      if (status) { query += ' AND status = ?'; args.push(status); }

      query += ' ORDER BY created_at DESC';
      const assets = db.prepare(query).all(...args);
      return sendJson(res, { assets }, 200, req);
    }

    // GET /api/content - ดึง content ที่ published แล้ว
    if (path === '/api/content' && method === 'GET') {
      const type = url.searchParams.get('type');
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 20 : Number(rawLimit);

      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }

      let query = 'SELECT id, title, slug, content_type, summary, status, published_at, platforms, canonical_url, views, shares FROM content WHERE status = ?';
      const args: any[] = ['published'];

      if (type) { query += ' AND content_type = ?'; args.push(type); }

      query += ' ORDER BY published_at DESC LIMIT ?';
      args.push(limit);

      const content = db.prepare(query).all(...args);
      return sendJson(res, { content }, 200, req);
    }

    // GET /api/content/:slug - ดึง content เดียว
    if (path.match(/^\/api\/content\/[\w-]+$/) && method === 'GET') {
      const slug = path.split('/').pop();
      const item = db.prepare('SELECT id, title, slug, content_type, summary, body_html, status, published_at, platforms, canonical_url, views, shares FROM content WHERE slug = ? AND status = ?').get(slug, 'published');

      if (!item) return sendJson(res, { error: 'Not found' }, 404, req);
      return sendJson(res, { content: item }, 200, req);
    }

    // GET /api/platform/building-blocks - which central gateway, SDK, edge rule,
    // or platform binding every app uses per capability. Read-only catalog.
    if (path === '/api/platform/building-blocks' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const filter: BuildingBlockFilter = {};
      for (const key of BUILDING_BLOCK_FILTERS) {
        const value = url.searchParams.get(key);
        if (value) filter[key] = value;
      }
      return sendJson(res, buildingBlocksResponse(filter), 200, req);
    }

    // POST /api/platform/commerce/tax/quote - Thai VAT and withholding for one amount.
    if (path === '/api/platform/commerce/tax/quote' && method === 'POST') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      return sendJson(res, taxQuote(await parseBody(req)), 200, req);
    }

    // POST /api/platform/billing/invoices/preview - Thai invoice totals; issues nothing.
    if (path === '/api/platform/billing/invoices/preview' && method === 'POST') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      return sendJson(res, invoicePreview(await parseBody(req)), 200, req);
    }

    // POST /api/platform/files/presign - short-lived R2 upload/download URL.
    if (path === '/api/platform/files/presign' && method === 'POST') {
      const auth = requireAuth(req, 'api:write');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const r2 = r2ConfigFromEnv();
      if (!r2) {
        return sendJson(res, { error: 'File storage is not configured' }, 503, req);
      }
      return sendJson(res, presignFile(await parseBody(req), r2), 200, req);
    }

    // POST /api/platform/messages/email - Resend delivery; dry-run until enabled.
    if (path === '/api/platform/messages/email' && method === 'POST') {
      const auth = requireAuth(req, 'api:write');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const result = await sendEmail(await parseBody(req));
      return sendJson(res, result, result.status === 'sent' ? 202 : 200, req);
    }

    // POST /api/platform/identity/verify - verify an end-user OIDC session token
    // issued by the configured identity provider; returns identifiers only.
    if (path === '/api/platform/identity/verify' && method === 'POST') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      let identity: IdentityConfig | null = null;
      try {
        identity = identityConfigFromEnv();
      } catch {
        identity = null;
      }
      if (!identity) {
        return sendJson(res, { error: 'Identity provider is not configured' }, 503, req);
      }
      return sendJson(res, await verifySessionRequest(await parseBody(req), identity), 200, req);
    }

    // GET /api/integrations - catalog of direct external API boundaries.
    if (path === '/api/integrations' && method === 'GET') {
      return sendJson(res, {
        source: 'infra/scripts/sync/integration_health.py',
        total_apps: EXTERNAL_APP_REGISTRY.length,
        status_counts: EXTERNAL_APP_REGISTRY.reduce((counts: Record<string, number>, app) => {
          counts[app.status] = (counts[app.status] || 0) + 1;
          return counts;
        }, {}),
        apps: EXTERNAL_APP_REGISTRY,
        integrations: EXTERNAL_INTEGRATIONS,
      }, 200, req);
    }

    // GET /api/integrations/health - bounded read-only provider checks.
    // Health can disclose account connectivity, so it is authenticated.
    if (path === '/api/integrations/health' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const health = await runIntegrationHealth(offline);
      return sendJson(res, health, 200, req);
    }

    // GET /api/integrations/discovery - bounded public catalog discovery.
    // This returns metadata only; it never installs or authenticates a service.
    if (path === '/api/integrations/discovery' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedSource = url.searchParams.get('source') || 'all';
      const source = requestedSource === 'apis-guru' || requestedSource === 'mcp-registry' || requestedSource === 'all'
        ? requestedSource
        : null;
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 1000 : Number(requestedLimit);
      if (!source) return sendJson(res, { error: 'source must be apis-guru, mcp-registry, or all' }, 400, req);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 10000' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const discovery = await runExternalDiscovery(source, limit, offline);
      return sendJson(res, discovery, 200, req);
    }

    // GET /api/integrations/sentry/issues - bounded, read-only issue summary.
    // This is authenticated because issue titles can contain private context.
    if (path === '/api/integrations/sentry/issues' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const issues = await runSentryIssues(limit, offline);
      return sendJson(res, issues, 200, req);
    }

    // GET /api/integrations/posthog/insights - bounded, read-only metadata.
    // This is authenticated because insight names and descriptions can be private.
    if (path === '/api/integrations/posthog/insights' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const insights = await runPostHogInsights(limit, offline);
      return sendJson(res, insights, 200, req);
    }

    // GET /api/integrations/slack/channels - bounded public-channel metadata.
    // This is authenticated and never reads messages or performs mutations.
    if (path === '/api/integrations/slack/channels' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const channels = await runSlackChannels(limit, offline);
      return sendJson(res, channels, 200, req);
    }

    // GET /api/integrations/notion/search - bounded metadata-only inventory.
    // This is authenticated and never reads block content or performs mutations.
    if (path === '/api/integrations/notion/search' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const query = (url.searchParams.get('query') || '').trim();
      if (query.length > 100) {
        return sendJson(res, { error: 'query must be at most 100 characters' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const results = await runNotionSearch(limit, query, offline);
      return sendJson(res, results, 200, req);
    }

    // GET /api/integrations/asana/workspaces - bounded workspace metadata.
    if (path === '/api/integrations/asana/workspaces' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const workspaces = await runAsana('workspaces', limit, '', offline);
      return sendJson(res, workspaces, 200, req);
    }

    // GET /api/integrations/asana/projects - bounded project metadata.
    // A workspace GID is required to avoid unbounded cross-domain queries.
    if (path === '/api/integrations/asana/projects' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const workspace = (url.searchParams.get('workspace') || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspace)) {
        return sendJson(res, { error: 'workspace must be a valid Asana workspace GID' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const projects = await runAsana('projects', limit, workspace, offline);
      return sendJson(res, projects, 200, req);
    }

    // GET /api/integrations/linear/teams - bounded team metadata.
    if (path === '/api/integrations/linear/teams' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const teams = await runLinear('teams', limit, offline);
      return sendJson(res, teams, 200, req);
    }

    // GET /api/integrations/linear/projects - bounded project metadata.
    if (path === '/api/integrations/linear/projects' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const projects = await runLinear('projects', limit, offline);
      return sendJson(res, projects, 200, req);
    }

    // GET /api/integrations/discord/guilds - bounded partial guild metadata.
    // This is authenticated and never reads messages or performs mutations.
    if (path === '/api/integrations/discord/guilds' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const guilds = await runDiscordGuilds(limit, offline);
      return sendJson(res, guilds, 200, req);
    }

    // GET /api/integrations/whatsapp-business/phone-numbers - bounded WABA metadata.
    // This is authenticated and never reads messages or performs mutations.
    if (path === '/api/integrations/whatsapp-business/phone-numbers' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const phoneNumbers = await runWhatsAppPhoneNumbers(limit, offline);
      return sendJson(res, phoneNumbers, 200, req);
    }

    // GET /api/integrations/microsoft-graph/me - bounded signed-in-user metadata.
    // This is authenticated and never reads mail, files, calendar, Teams, or mutates Graph.
    if (path === '/api/integrations/microsoft-graph/me' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const profile = await runMicrosoftGraphProfile(offline);
      return sendJson(res, profile, 200, req);
    }

    // GET /api/integrations/zoom/me - bounded authenticated-user metadata.
    // This is authenticated and never reads meetings or performs mutations.
    if (path === '/api/integrations/zoom/me' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const profile = await runZoomProfile(offline);
      return sendJson(res, profile, 200, req);
    }

    // GET /api/integrations/monday/boards - bounded board metadata.
    // This is authenticated and never reads items or performs mutations.
    if (path === '/api/integrations/monday/boards' && method === 'GET') {
      const auth = requireAuth(req, 'api:read');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
      const requestedLimit = url.searchParams.get('limit');
      const limit = requestedLimit === null ? 20 : Number(requestedLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendJson(res, { error: 'limit must be an integer between 1 and 100' }, 400, req);
      }
      const offline = url.searchParams.get('offline') === 'true';
      const boards = await runMondayBoards(limit, offline);
      return sendJson(res, boards, 200, req);
    }

    // POST /api/webhook/line - LINE signs this public ingress instead of using
    // the internal Bearer token. The raw body must be verified before parsing.
    if (path === '/api/webhook/line' && method === 'POST') {
      const rawBody = await parseRawBody(req);
      const channelSecret = process.env.LINE_SOLO_EMPIRE_WEBHOOK_SECRET;
      const signature = typeof req.headers['x-line-signature'] === 'string'
        ? req.headers['x-line-signature']
        : undefined;

      if (!channelSecret) {
        return sendJson(res, { error: 'LINE webhook is not configured' }, 503, req);
      }
      if (!verifyLineSignature(rawBody, signature, channelSecret)) {
        return sendJson(res, { error: 'Invalid LINE webhook signature' }, 401, req);
      }

      let body: any;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, { error: 'Request body must be valid JSON' }, 400, req);
      }

      if (!body || !Array.isArray(body.events)) {
        return sendJson(res, { error: 'LINE webhook body must include an events array' }, 400, req);
      }

      const events = body.events.filter((event: any): event is LineWebhookEvent => (
        event && typeof event === 'object' && typeof event.type === 'string'
      ));
      if (events.length !== body.events.length) {
        return sendJson(res, { error: 'Each LINE webhook event must include a type' }, 400, req);
      }

      let acceptedEvents = 0;
      let duplicateEvents = 0;
      const insertEvent = db.prepare(`
        INSERT INTO webhook_log (source, event_type, external_id, payload, processed)
        VALUES ('line', ?, ?, ?, 0)
      `);
      const findExisting = db.prepare(
        "SELECT id FROM webhook_log WHERE source = 'line' AND external_id = ? LIMIT 1",
      );

      db.transaction(() => {
        for (const event of events) {
          const externalId = getLineEventExternalId(event);
          if (externalId && findExisting.get(externalId)) {
            duplicateEvents += 1;
            continue;
          }

          insertEvent.run(
            event.type,
            externalId,
            JSON.stringify({ destination: body.destination || null, event }),
          );
          acceptedEvents += 1;
        }
      })();

      return sendJson(res, {
        success: true,
        source: 'line',
        received_events: events.length,
        accepted_events: acceptedEvents,
        duplicate_events: duplicateEvents,
        processing: 'queued',
      }, 200, req);
    }

    // POST /api/webhook/stripe - signed Stripe ingress only. Payment events
    // remain pending in webhook_log; this route never creates charges/refunds.
    if (path === '/api/webhook/stripe' && method === 'POST') {
      const rawBody = await parseRawBody(req);
      const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const signature = typeof req.headers['stripe-signature'] === 'string'
        ? req.headers['stripe-signature']
        : undefined;

      if (!endpointSecret) {
        return sendJson(res, { error: 'Stripe webhook is not configured' }, 503, req);
      }
      const verification = verifyStripeSignature(rawBody, signature, endpointSecret);
      if (!verification.valid) {
        return sendJson(res, { error: 'Invalid Stripe webhook signature' }, 400, req);
      }

      let body: any;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return sendJson(res, { error: 'Request body must be valid JSON' }, 400, req);
      }

      if (!body || typeof body.id !== 'string' || !body.id.trim() || typeof body.type !== 'string' || !body.type.trim()) {
        return sendJson(res, { error: 'Stripe event must include id and type' }, 400, req);
      }

      const existing = db.prepare(
        "SELECT id FROM webhook_log WHERE source = 'stripe' AND external_id = ? LIMIT 1",
      ).get(body.id.trim());
      if (existing) {
        return sendJson(res, {
          success: true,
          source: 'stripe',
          received: true,
          accepted_events: 0,
          duplicate_events: 1,
          processing: 'queued',
        }, 200, req);
      }

      db.prepare(`
        INSERT INTO webhook_log (source, event_type, external_id, payload, processed)
        VALUES ('stripe', ?, ?, ?, 0)
      `).run(body.type.trim(), body.id.trim(), rawBody.toString('utf8'));

      return sendJson(res, {
        success: true,
        source: 'stripe',
        received: true,
        accepted_events: 1,
        duplicate_events: 0,
        processing: 'queued',
      }, 200, req);
    }

    // =====================================================
    // SYNC API: สำหรับอัพเดทข้อมูลจากที่เดียวไปหลายเว็บ
    // Requires Bearer token when API_TOKEN is set
    // =====================================================

    // Auth guard for all /api/sync/* and /api/webhook/* routes
    if (path.startsWith('/api/sync/') || path.startsWith('/api/webhook/')) {
      const auth = requireAuth(req, 'api:write');
      if (!auth.authorized) {
        return sendAuthFailure(res, req, auth);
      }
    }

    // POST /api/sync/profile - อัพเดท profile + log sync
    if (path === '/api/sync/profile' && method === 'POST') {
      const body = await parseBody(req);

      // Allowlist: only these fields can be updated
      const ALLOWED_FIELDS = ['name', 'title', 'bio', 'tagline', 'location', 'email', 'website', 'avatar_url', 'header_image_url'];
      const filteredBody = Object.fromEntries(
        Object.entries(body).filter(([k]) => ALLOWED_FIELDS.includes(k))
      );

      const existing = db.prepare('SELECT id FROM profile LIMIT 1').get() as any;

      if (existing && Object.keys(filteredBody).length > 0) {
        const fields = Object.entries(filteredBody)
          .map(([k, v]) => `${k} = ?`)
          .join(', ');

        const values = Object.values(filteredBody);

        db.prepare(`UPDATE profile SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...values, existing.id);
      } else if (!existing && Object.keys(filteredBody).length > 0) {
        const columns = Object.keys(filteredBody).join(', ');
        const placeholders = Object.keys(filteredBody).map(() => '?').join(', ');
        const values = Object.values(filteredBody);

        db.prepare(`INSERT INTO profile (${columns}) VALUES (${placeholders})`)
          .run(...values);
      }

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (entity_type, entity_id, target_system, status, data_synced)
        VALUES ('profile', 1, 'api', 'success', ?)
      `).run(JSON.stringify(filteredBody));

      const updated = db.prepare('SELECT * FROM profile LIMIT 1').get();
      return sendJson(res, { success: true, profile: updated }, 200, req);
    }

    // POST /api/sync/social-links - อัพเดท social links ทั้งหมด
    if (path === '/api/sync/social-links' && method === 'POST') {
      const body = await parseBody(req);
      const { links } = body;

      if (!Array.isArray(links)) {
        return sendJson(res, { error: 'links must be an array' }, 400, req);
      }

      if (links.length > 50) {
        return sendJson(res, { error: 'Too many links (max 50)' }, 400, req);
      }

      // Validate each link
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        if (!link.platform || typeof link.platform !== 'string') {
          return sendJson(res, { error: `Link ${i}: platform is required and must be a string` }, 400, req);
        }
        if (!link.url || typeof link.url !== 'string') {
          return sendJson(res, { error: `Link ${i}: url is required and must be a string` }, 400, req);
        }
        if (!isValidUrl(link.url)) {
          return sendJson(res, { error: `Link ${i}: invalid URL format: ${link.url}` }, 400, req);
        }
      }

      const transaction = db.transaction((links: any[]) => {
        // Deactivate all first
        db.prepare('UPDATE social_links SET is_active = 0').run();

        // Upsert each link
        for (const link of links) {
          const existing = db.prepare('SELECT id FROM social_links WHERE platform = ?').get(link.platform) as any;

          if (existing) {
            db.prepare(`
              UPDATE social_links
              SET url = ?, username = ?, display_name = ?, description = ?,
                  is_primary = ?, sort_order = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).run(link.url, link.username || null, link.display_name || null,
                   link.description || null, link.is_primary ? 1 : 0, link.sort_order || 0, existing.id);
          } else {
            db.prepare(`
              INSERT INTO social_links (platform, url, username, display_name, description, is_primary, sort_order, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `).run(link.platform, link.url, link.username || null, link.display_name || null,
                   link.description || null, link.is_primary ? 1 : 0, link.sort_order || 0);
          }
        }
      });

      transaction(links);

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (entity_type, target_system, status, data_synced)
        VALUES ('social_links', 'api', 'success', ?)
      `).run(JSON.stringify(body));

      const updated = db.prepare('SELECT * FROM social_links WHERE is_active = 1 ORDER BY sort_order').all();
      return sendJson(res, { success: true, links: updated }, 200, req);
    }

    // POST /api/sync/content - อัพเดท content สำหรับ publish หลายที่
    if (path === '/api/sync/content' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.title && !body.slug) {
        return sendJson(res, { error: 'Missing required fields: title or slug' }, 400, req);
      }

      // Allowlist: only these fields can be updated
      const ALLOWED_FIELDS = ['title', 'slug', 'content_type', 'summary', 'body', 'body_html', 'status', 'published_at', 'platforms', 'canonical_url', 'views', 'shares', 'leads_generated', 'meta_title', 'meta_description', 'keywords', 'related_skill_ids', 'related_niche_id', 'notes'];
      const filteredBody = Object.fromEntries(
        Object.entries(body).filter(([k]) => ALLOWED_FIELDS.includes(k))
      );

      const existing = body.slug
        ? db.prepare('SELECT id FROM content WHERE slug = ?').get(body.slug) as any
        : null;

      if (existing && Object.keys(filteredBody).length > 0) {
        const fields = Object.entries(filteredBody)
          .map(([k]) => `${k} = ?`)
          .join(', ');

        const values = Object.values(filteredBody);

        db.prepare(`UPDATE content SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...values, existing.id);
      } else if (!existing && Object.keys(filteredBody).length > 0) {
        const columns = Object.keys(filteredBody).join(', ');
        const placeholders = Object.keys(filteredBody).map(() => '?').join(', ');
        const values = Object.values(filteredBody);

        db.prepare(`INSERT INTO content (${columns}) VALUES (${placeholders})`)
          .run(...values);
      }

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (entity_type, target_system, status, data_synced)
        VALUES ('content', ?, 'success', ?)
      `).run(body.platforms || 'api', JSON.stringify(filteredBody));

      return sendJson(res, { success: true }, 200, req);
    }

    // =====================================================
    // WEBHOOK API: สำหรับรับข้อมูลจาก external services
    // =====================================================

    // POST /api/webhook/analytics - รับ analytics data
    if (path === '/api/webhook/analytics' && method === 'POST') {
      const body = await parseBody(req);
      const { asset_id, metric_date, views, subscribers, revenue, engagement_rate } = body;
      const assetId = Number(asset_id);

      if (!Number.isInteger(assetId) || assetId <= 0 || !metric_date) {
        return sendJson(res, { error: 'Missing required fields: asset_id, metric_date' }, 400, req);
      }

      if (typeof metric_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(metric_date)) {
        return sendJson(res, { error: 'metric_date must use YYYY-MM-DD format' }, 400, req);
      }

      const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId);
      if (!asset) {
        return sendJson(res, { error: 'Asset not found' }, 404, req);
      }

      // Validate numeric ranges
      if (views !== undefined && (typeof views !== 'number' || !Number.isFinite(views) || views < 0 || views > 1e9)) {
        return sendJson(res, { error: 'views must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (subscribers !== undefined && (typeof subscribers !== 'number' || !Number.isFinite(subscribers) || subscribers < 0 || subscribers > 1e9)) {
        return sendJson(res, { error: 'subscribers must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (revenue !== undefined && (typeof revenue !== 'number' || !Number.isFinite(revenue) || revenue < 0 || revenue > 1e9)) {
        return sendJson(res, { error: 'revenue must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (engagement_rate !== undefined && (typeof engagement_rate !== 'number' || !Number.isFinite(engagement_rate) || engagement_rate < 0 || engagement_rate > 100)) {
        return sendJson(res, { error: 'engagement_rate must be a number between 0 and 100' }, 400, req);
      }

      const previous = db.prepare(`
        SELECT views, subscribers, revenue, engagement_rate
        FROM asset_metrics WHERE asset_id = ? AND metric_date = ?
      `).get(assetId, metric_date) as any;
      const nextViews = views ?? 0;
      const nextSubscribers = subscribers ?? 0;
      const nextRevenue = revenue ?? 0;
      const nextEngagementRate = engagement_rate ?? previous?.engagement_rate ?? null;

      const updateMetrics = db.prepare(`
        INSERT INTO asset_metrics (asset_id, metric_date, views, subscribers, revenue, engagement_rate)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id, metric_date) DO UPDATE SET
          views = excluded.views,
          subscribers = excluded.subscribers,
          revenue = excluded.revenue,
          engagement_rate = excluded.engagement_rate
      `);
      const updateTotals = db.prepare(`
        UPDATE assets SET
          views = COALESCE(views, 0) + ?,
          subscribers = COALESCE(subscribers, 0) + ?,
          revenue = COALESCE(revenue, 0) + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      db.transaction(() => {
        updateMetrics.run(assetId, metric_date, nextViews, nextSubscribers, nextRevenue, nextEngagementRate);
        updateTotals.run(
          nextViews - (previous?.views ?? 0),
          nextSubscribers - (previous?.subscribers ?? 0),
          nextRevenue - (previous?.revenue ?? 0),
          assetId,
        );
      })();

      return sendJson(res, { success: true, updated: Boolean(previous) }, 200, req);
    }

    // POST /api/webhook/revenue - รับ revenue data
    if (path === '/api/webhook/revenue' && method === 'POST') {
      const body = await parseBody(req);
      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key'].trim()
        : '';

      if (!body.source_type || !body.source_name || !body.amount || !body.revenue_date) {
        return sendJson(res, { error: 'Missing required fields: source_type, source_name, amount, revenue_date' }, 400, req);
      }

      if (!idempotencyKey || idempotencyKey.length > 255) {
        return sendJson(res, { error: 'Idempotency-Key header is required and must be at most 255 characters' }, 400, req);
      }

      if (typeof body.revenue_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.revenue_date)) {
        return sendJson(res, { error: 'revenue_date must use YYYY-MM-DD format' }, 400, req);
      }

      // Validate amount is a positive number
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0 || body.amount > 1e9) {
        return sendJson(res, { error: 'amount must be a positive number up to 1,000,000,000' }, 400, req);
      }

      // Validate source_type is one of the allowed values
      const VALID_SOURCE_TYPES = ['service', 'product', 'subscription', 'affiliate', 'ad', 'sponsorship', 'other'];
      if (!VALID_SOURCE_TYPES.includes(body.source_type)) {
        return sendJson(res, { error: `source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}` }, 400, req);
      }

      const existing = db.prepare(`
        SELECT id FROM revenue WHERE idempotency_key = ?
      `).get(idempotencyKey) as any;
      if (existing) {
        return sendJson(res, { success: true, id: existing.id, duplicate: true }, 200, req);
      }

      const result = db.prepare(`
        INSERT INTO revenue (source_type, source_name, amount, currency, revenue_date, description, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(body.source_type, body.source_name, body.amount, body.currency || 'THB', body.revenue_date, body.description || null, idempotencyKey);

      return sendJson(res, { success: true, id: result.lastInsertRowid }, 200, req);
    }

    // =====================================================
    // HEALTH CHECK
    // =====================================================
    if (path === '/health' || path === '/') {
      return sendJson(res, {
        status: 'ok',
        service: 'solo-empire-api',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }, 200, req);
    }

    // 404
    return sendJson(res, { error: 'Not found' }, 404, req);

  } catch (error: any) {
    console.error('Error:', error);
    const known = error instanceof HttpError || error instanceof PlatformInputError;
    const status = known ? error.status : 500;
    const message = status >= 500 && !(error instanceof PlatformInputError) ? 'Internal server error' : error.message;
    return sendJson(res, { error: message }, status, req);
  }
}

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  // Production safety: require a valid legacy or scoped auth configuration.
  if (process.env.NODE_ENV === 'production' && authConfigurationError()) {
    console.error('ERROR: API_TOKENS_JSON is invalid in production mode');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !authConfigurationPresent()) {
    console.error('ERROR: API_TOKEN or API_TOKENS_JSON is required in production mode');
    console.error('Set a legacy API_TOKEN or provision scoped token hashes before starting production');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && financeRateLimitConfigurationError()) {
    console.error('ERROR: Finance API rate-limit configuration is invalid in production mode');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && AI_RATE_LIMITER.status().configuration_error) {
    console.error('ERROR: AI gateway rate-limit configuration is invalid in production mode');
    process.exit(1);
  }

  await initDb();

  const server = createServer(handleRequest);
  server.listen(PORT, API_HOST, () => {
    console.log(`Solo Empire API running on http://${API_HOST}:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Profile: http://localhost:${PORT}/api/profile`);
    console.log(`Skills: http://localhost:${PORT}/api/skills`);
    if (!API_TOKEN && !authConfigurationPresent()) {
      console.log('');
      console.log('╔══════════════════════════════════════════════════════════════╗');
      console.log('║  ⚠️  SECURITY WARNING: Write routes are UNAUTHENTICATED     ║');
      console.log('║  Anyone with network access can modify your database.        ║');
      console.log('║                                                              ║');
      console.log('║  To enable dev mode explicitly, set:                         ║');
      console.log('║    ALLOW_UNAUTH_DEV=true                                     ║');
      console.log('║                                                              ║');
      console.log('║  For production, set API_TOKEN in your .env file.            ║');
      console.log('╚══════════════════════════════════════════════════════════════╝');
      console.log('');
    } else if (API_TOKEN) {
      console.log(`Auth: legacy Bearer token enabled`);
    } else {
      console.log(`Auth: scoped Bearer token registry enabled`);
    }
  });
}

startServer();

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});
