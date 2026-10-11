/**
 * Route access matrix for infra/api/server.ts.
 *
 * server.ts routes with inline `if (path ... && method === ...)` blocks and
 * starts listening on import, so this test reads the source: it extracts every
 * route condition in handleRequestInner and the guard that protects it (an
 * inline `requireAuth(req, '<scope>')`, a provider signature check, or an
 * earlier prefix guard such as the `/api/sync/` + `/api/webhook/` one), then
 * compares the result with EXPECTED. A new route fails until it is classified
 * here, and no state-changing route may be public.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'server.ts');

type Level = 'public' | 'signature' | 'api:read' | 'api:write' | 'ai:generate';

// "METHOD path" (ANY when the route does not check the method).
const EXPECTED: Record<string, Level> = {
  'GET /api/ai/status': 'public',
  'POST /api/ai/generate': 'ai:generate',
  'GET /api/finance/v1': 'public',
  'GET /api/finance/v1/*': 'public',
  // Public read model for the landing page.
  'GET /api/profile': 'public',
  'GET /api/skills': 'public',
  'GET /^\\/api\\/skills\\/[\\w-]+$/': 'public',
  'GET /api/assets': 'public',
  'GET /api/content': 'public',
  'GET /^\\/api\\/content\\/[\\w-]+$/': 'public',
  'GET /api/integrations': 'public',
  'GET /api/integrations/health': 'api:read',
  'GET /api/platform/building-blocks': 'api:read',
  // Stateless calculations; nothing is stored or issued.
  'POST /api/platform/commerce/tax/quote': 'api:read',
  'POST /api/platform/billing/invoices/preview': 'api:read',
  'POST /api/platform/files/presign': 'api:write',
  'POST /api/platform/messages/email': 'api:write',
  'POST /api/platform/identity/verify': 'api:read',
  'GET /api/integrations/discovery': 'api:read',
  'GET /api/integrations/sentry/issues': 'api:read',
  'GET /api/integrations/posthog/insights': 'api:read',
  'GET /api/integrations/slack/channels': 'api:read',
  'GET /api/integrations/notion/search': 'api:read',
  'GET /api/integrations/asana/workspaces': 'api:read',
  'GET /api/integrations/asana/projects': 'api:read',
  'GET /api/integrations/linear/teams': 'api:read',
  'GET /api/integrations/linear/projects': 'api:read',
  'GET /api/integrations/discord/guilds': 'api:read',
  'GET /api/integrations/whatsapp-business/phone-numbers': 'api:read',
  'GET /api/integrations/microsoft-graph/me': 'api:read',
  'GET /api/integrations/zoom/me': 'api:read',
  'GET /api/integrations/monday/boards': 'api:read',
  'POST /api/sync/profile': 'api:write',
  'POST /api/sync/social-links': 'api:write',
  'POST /api/sync/content': 'api:write',
  'POST /api/webhook/analytics': 'api:write',
  'POST /api/webhook/revenue': 'api:write',
  // Retired: the local webhook_log queue is gone (410 behind the prefix guard).
  'POST /api/webhook/line': 'api:write',
  'POST /api/webhook/stripe': 'api:write',
  // Liveness; answers every method with a static body and changes nothing.
  'ANY /health': 'public',
  'ANY /': 'public',
};

interface Route {
  key: string;
  path: string;
  line: number;
  level: Level;
}

function handlerBody(source: string): { lines: string[]; offset: number } {
  const start = source.indexOf('async function handleRequestInner(');
  const end = source.indexOf('\nasync function startServer(');
  assert.ok(start > 0 && end > start, 'handleRequestInner not found in server.ts');
  const offset = source.slice(0, start).split('\n').length - 1;
  return { lines: source.slice(start, end).split('\n'), offset };
}

function conditionPaths(condition: string): string[] {
  const paths: string[] = [];
  for (const m of condition.matchAll(/path === '([^']+)'/g)) paths.push(m[1]);
  for (const m of condition.matchAll(/path\.match\((\/.+?\/)\)/g)) paths.push(m[1]);
  for (const m of condition.matchAll(/path\.startsWith\('([^']+)'\)/g)) paths.push(`${m[1].replace(/\/$/, '')}/*`);
  return paths;
}

function extractRoutes(): Route[] {
  const { lines, offset } = handlerBody(readFileSync(SERVER, 'utf8'));
  const prefixGuards: { prefixes: string[]; scope: Level; line: number }[] = [];
  const found: { condition: string; line: number }[] = [];

  lines.forEach((text, index) => {
    const m = /^\s*if \((.*)\) \{\s*$/.exec(text);
    if (!m || !/\bpath(\.| ===)/.test(m[1])) return;
    const condition = m[1];
    const onlyPrefixes = /^(\s*path\.startsWith\('[^']+'\)\s*(\|\|)?)+$/.test(condition);
    const authLine = lines.slice(index + 1, index + 3).join('\n');
    const auth = /requireAuth\(req, '([^']+)'\)/.exec(authLine);
    if (onlyPrefixes && auth) {
      prefixGuards.push({
        prefixes: [...condition.matchAll(/path\.startsWith\('([^']+)'\)/g)].map((p) => p[1]),
        scope: auth[1] as Level,
        line: index,
      });
      return;
    }
    found.push({ condition, line: index });
  });

  const routes: Route[] = [];
  const boundaries = [...found.map((f) => f.line), ...prefixGuards.map((g) => g.line), lines.length].sort((a, b) => a - b);
  found.forEach(({ condition, line }) => {
    const next = boundaries.find((b) => b > line) ?? lines.length;
    const block = lines.slice(line, next).join('\n');
    const methods = [...condition.matchAll(/method === '(\w+)'/g)].map((m) => m[1]);
    const inline = /requireAuth\(req, '([^']+)'\)/.exec(block);
    for (const path of conditionPaths(condition)) {
      let level: Level = 'public';
      if (inline) {
        level = inline[1] as Level;
      } else if (/verify\w*Signature\(/.test(block)) {
        level = 'signature';
      } else {
        const guard = prefixGuards.find((g) => g.line < line && g.prefixes.some((p) => path.startsWith(p)));
        if (guard) level = guard.scope;
      }
      for (const method of methods.length ? methods : ['ANY']) {
        routes.push({ key: `${method} ${path}`, path, line: line + offset + 1, level });
      }
    }
  });
  return routes;
}

const routes = extractRoutes();

test('route extraction sees the whole handler', () => {
  assert.ok(routes.length >= 30, `only ${routes.length} routes found; the extractor is broken`);
  const keys = routes.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate route keys');
});

test('every route in server.ts is classified, and nothing stale is listed', () => {
  const served = new Set(routes.map((r) => r.key));
  const unclassified = routes.filter((r) => !(r.key in EXPECTED)).map((r) => `${r.key} (server.ts:${r.line})`);
  const stale = Object.keys(EXPECTED).filter((key) => !served.has(key));
  assert.deepEqual(unclassified, [], 'classify these routes in EXPECTED');
  assert.deepEqual(stale, [], 'EXPECTED lists routes server.ts no longer serves');
});

test('each route is guarded at its expected level', () => {
  const mismatched = routes
    .filter((r) => EXPECTED[r.key] !== undefined && EXPECTED[r.key] !== r.level)
    .map((r) => `${r.key}: server.ts:${r.line} is ${r.level}, expected ${EXPECTED[r.key]}`);
  assert.deepEqual(mismatched, []);
});

test('no state-changing route is public', () => {
  const publicWrites = Object.entries(EXPECTED)
    .filter(([key, level]) => level === 'public' && /^(POST|PUT|PATCH|DELETE) /.test(key))
    .map(([key]) => key);
  assert.deepEqual(publicWrites, []);
  const anyMethodPublic = Object.entries(EXPECTED)
    .filter(([key, level]) => level === 'public' && key.startsWith('ANY '))
    .map(([key]) => key);
  // Only the static liveness responses may ignore the method.
  assert.deepEqual(anyMethodPublic.sort(), ['ANY /', 'ANY /health']);
});
