import { createServer } from 'http';
import { getDb, initDb, closeDb } from '../mcp-server/src/db.js';
import { URL } from 'url';

const PORT = process.env.PORT || 3001;
const API_TOKEN = process.env.API_TOKEN || '';  // Bearer token for write routes
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '1048576'); // 1MB default

// CORS headers — restrict origin in production
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173').split(',');
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function getCorsHeaders(req: any): Record<string, string> {
  const origin = req.headers.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { ...corsHeaders, 'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin' };
}

/**
 * Validate Bearer token for write routes.
 * If API_TOKEN is set in env, require it. If not set, allow all (dev mode).
 * Dev mode requires ALLOW_UNAUTH_DEV=true to be explicitly set.
 */
function requireAuth(req: any): { authorized: boolean; error?: string } {
  if (!API_TOKEN) {
    if (process.env.ALLOW_UNAUTH_DEV !== 'true') {
      return { authorized: false, error: 'Unauthenticated writes disabled. Set ALLOW_UNAUTH_DEV=true for dev mode.' };
    }
    return { authorized: true };  // dev mode: no token required
  }
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return { authorized: false, error: 'Missing Authorization header' };
  if (match[1] !== API_TOKEN) return { authorized: false, error: 'Invalid token' };
  return { authorized: true };
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

function sendJson(res: any, data: any, status = 200, req?: any) {
  const headers = req ? getCorsHeaders(req) : { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error(`Request body too large (max ${MAX_BODY_SIZE} bytes)`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// =====================================================
// ROUTES
// =====================================================

async function handleRequest(req: any, res: any) {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
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
    // =====================================================
    // PUBLIC API: สำหรับ landing page ดึงข้อมูลไปแสดง
    // =====================================================

    // GET /api/profile - ดึงข้อมูล profile
    if (path === '/api/profile' && method === 'GET') {
      const profile = db.prepare('SELECT * FROM profile LIMIT 1').get();
      const socialLinks = db.prepare('SELECT * FROM social_links WHERE is_active = 1 ORDER BY sort_order').all();
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
        SELECT s.*, sc.name as category_name, sc.slug as category_slug
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

      let query = 'SELECT * FROM assets WHERE 1=1';
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
      const limit = parseInt(url.searchParams.get('limit') || '20');

      let query = 'SELECT * FROM content WHERE status = ?';
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
      const item = db.prepare('SELECT * FROM content WHERE slug = ? AND status = ?').get(slug, 'published');

      if (!item) return sendJson(res, { error: 'Not found' }, 404, req);
      return sendJson(res, { content: item }, 200, req);
    }

    // =====================================================
    // SYNC API: สำหรับอัพเดทข้อมูลจากที่เดียวไปหลายเว็บ
    // Requires Bearer token when API_TOKEN is set
    // =====================================================

    // Auth guard for all /api/sync/* and /api/webhook/* routes
    if (path.startsWith('/api/sync/') || path.startsWith('/api/webhook/')) {
      const auth = requireAuth(req);
      if (!auth.authorized) {
        return sendJson(res, { error: 'Unauthorized', message: auth.error }, 401, req);
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

      if (!asset_id || !metric_date) {
        return sendJson(res, { error: 'Missing required fields: asset_id, metric_date' }, 400, req);
      }

      // Validate numeric ranges
      if (views !== undefined && (typeof views !== 'number' || views < 0 || views > 1e9)) {
        return sendJson(res, { error: 'views must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (subscribers !== undefined && (typeof subscribers !== 'number' || subscribers < 0 || subscribers > 1e9)) {
        return sendJson(res, { error: 'subscribers must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (revenue !== undefined && (typeof revenue !== 'number' || revenue < 0 || revenue > 1e9)) {
        return sendJson(res, { error: 'revenue must be a number between 0 and 1,000,000,000' }, 400, req);
      }
      if (engagement_rate !== undefined && (typeof engagement_rate !== 'number' || engagement_rate < 0 || engagement_rate > 100)) {
        return sendJson(res, { error: 'engagement_rate must be a number between 0 and 100' }, 400, req);
      }

      db.prepare(`
        INSERT OR REPLACE INTO asset_metrics (asset_id, metric_date, views, subscribers, revenue, engagement_rate)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(asset_id, metric_date, views || 0, subscribers || 0, revenue || 0, engagement_rate || null);

      // Update asset totals
      if (views || subscribers || revenue) {
        db.prepare(`
          UPDATE assets SET
            views = COALESCE(views, 0) + ?,
            subscribers = COALESCE(subscribers, 0) + ?,
            revenue = COALESCE(revenue, 0) + ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(views || 0, subscribers || 0, revenue || 0, asset_id);
      }

      return sendJson(res, { success: true }, 200, req);
    }

    // POST /api/webhook/revenue - รับ revenue data
    if (path === '/api/webhook/revenue' && method === 'POST') {
      const body = await parseBody(req);

      if (!body.source_type || !body.source_name || !body.amount || !body.revenue_date) {
        return sendJson(res, { error: 'Missing required fields: source_type, source_name, amount, revenue_date' }, 400, req);
      }

      // Validate amount is a positive number
      if (typeof body.amount !== 'number' || body.amount <= 0 || body.amount > 1e9) {
        return sendJson(res, { error: 'amount must be a positive number up to 1,000,000,000' }, 400, req);
      }

      // Validate source_type is one of the allowed values
      const VALID_SOURCE_TYPES = ['service', 'product', 'subscription', 'affiliate', 'ad', 'sponsorship', 'other'];
      if (!VALID_SOURCE_TYPES.includes(body.source_type)) {
        return sendJson(res, { error: `source_type must be one of: ${VALID_SOURCE_TYPES.join(', ')}` }, 400, req);
      }

      const result = db.prepare(`
        INSERT INTO revenue (source_type, source_name, amount, currency, revenue_date, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(body.source_type, body.source_name, body.amount, body.currency || 'THB', body.revenue_date, body.description || null);

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
    return sendJson(res, { error: error.message }, 500, req);
  }
}

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  // Production safety: require API_TOKEN when NODE_ENV=production
  if (process.env.NODE_ENV === 'production' && !API_TOKEN) {
    console.error('ERROR: API_TOKEN environment variable is required in production mode');
    console.error('Set API_TOKEN or run in development mode (NODE_ENV=development)');
    process.exit(1);
  }

  await initDb();
  
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Solo Empire API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Profile: http://localhost:${PORT}/api/profile`);
    console.log(`Skills: http://localhost:${PORT}/api/skills`);
    if (!API_TOKEN) {
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
    } else {
      console.log(`Auth: Bearer token enabled`);
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
