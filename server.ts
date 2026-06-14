import { createServer } from 'http';
import { getDb, initDb, closeDb } from '../mcp-server/src/db.js';
import { URL } from 'url';

const PORT = process.env.PORT || 3001;

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function sendJson(res: any, data: any, status = 200) {
  res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
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
    res.writeHead(204, corsHeaders);
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
      return sendJson(res, { profile, socialLinks });
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
      return sendJson(res, { skills });
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

      if (!skill) return sendJson(res, { error: 'Not found' }, 404);
      return sendJson(res, { skill });
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
      return sendJson(res, { assets });
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
      return sendJson(res, { content });
    }

    // GET /api/content/:slug - ดึง content เดียว
    if (path.match(/^\/api\/content\/[\w-]+$/) && method === 'GET') {
      const slug = path.split('/').pop();
      const item = db.prepare('SELECT * FROM content WHERE slug = ? AND status = ?').get(slug, 'published');

      if (!item) return sendJson(res, { error: 'Not found' }, 404);
      return sendJson(res, { content: item });
    }

    // =====================================================
    // SYNC API: สำหรับอัพเดทข้อมูลจากที่เดียวไปหลายเว็บ
    // =====================================================

    // POST /api/sync/profile - อัพเดท profile + log sync
    if (path === '/api/sync/profile' && method === 'POST') {
      const body = await parseBody(req);

      const existing = db.prepare('SELECT id FROM profile LIMIT 1').get() as any;

      if (existing) {
        const fields = Object.entries(body)
          .filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k))
          .map(([k, v]) => `${k} = ?`)
          .join(', ');

        if (fields) {
          const values = Object.entries(body)
            .filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k))
            .map(([_, v]) => v);

          db.prepare(`UPDATE profile SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(...values, existing.id);
        }
      } else {
        const columns = Object.keys(body).join(', ');
        const placeholders = Object.keys(body).map(() => '?').join(', ');
        const values = Object.values(body);

        db.prepare(`INSERT INTO profile (${columns}) VALUES (${placeholders})`)
          .run(...values);
      }

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (entity_type, entity_id, target_system, status, data_synced)
        VALUES ('profile', 1, 'api', 'success', ?)
      `).run(JSON.stringify(body));

      const updated = db.prepare('SELECT * FROM profile LIMIT 1').get();
      return sendJson(res, { success: true, profile: updated });
    }

    // POST /api/sync/social-links - อัพเดท social links ทั้งหมด
    if (path === '/api/sync/social-links' && method === 'POST') {
      const body = await parseBody(req);
      const { links } = body;

      if (!Array.isArray(links)) {
        return sendJson(res, { error: 'links must be an array' }, 400);
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
      return sendJson(res, { success: true, links: updated });
    }

    // POST /api/sync/content - อัพเดท content สำหรับ publish หลายที่
    if (path === '/api/sync/content' && method === 'POST') {
      const body = await parseBody(req);

      const existing = body.slug
        ? db.prepare('SELECT id FROM content WHERE slug = ?').get(body.slug) as any
        : null;

      if (existing) {
        const fields = Object.entries(body)
          .filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k))
          .map(([k]) => `${k} = ?`)
          .join(', ');

        const values = Object.entries(body)
          .filter(([k]) => !['id', 'created_at', 'updated_at'].includes(k))
          .map(([_, v]) => v);

        db.prepare(`UPDATE content SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...values, existing.id);
      } else {
        const columns = Object.keys(body).join(', ');
        const placeholders = Object.keys(body).map(() => '?').join(', ');
        const values = Object.values(body);

        db.prepare(`INSERT INTO content (${columns}) VALUES (${placeholders})`)
          .run(...values);
      }

      // Log sync
      db.prepare(`
        INSERT INTO sync_log (entity_type, target_system, status, data_synced)
        VALUES ('content', ?, 'success', ?)
      `).run(body.platforms || 'api', JSON.stringify(body));

      return sendJson(res, { success: true });
    }

    // =====================================================
    // WEBHOOK API: สำหรับรับข้อมูลจาก external services
    // =====================================================

    // POST /api/webhook/analytics - รับ analytics data
    if (path === '/api/webhook/analytics' && method === 'POST') {
      const body = await parseBody(req);
      const { asset_id, metric_date, views, subscribers, revenue, engagement_rate } = body;

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

      return sendJson(res, { success: true });
    }

    // POST /api/webhook/revenue - รับ revenue data
    if (path === '/api/webhook/revenue' && method === 'POST') {
      const body = await parseBody(req);

      const result = db.prepare(`
        INSERT INTO revenue (source_type, source_name, amount, currency, revenue_date, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(body.source_type, body.source_name, body.amount, body.currency || 'THB', body.revenue_date, body.description || null);

      return sendJson(res, { success: true, id: result.lastInsertRowid });
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
      });
    }

    // 404
    return sendJson(res, { error: 'Not found' }, 404);

  } catch (error: any) {
    console.error('Error:', error);
    return sendJson(res, { error: error.message }, 500);
  }
}

// =====================================================
// START SERVER
// =====================================================

async function startServer() {
  await initDb();
  
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Solo Empire API running on http://localhost:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Profile: http://localhost:${PORT}/api/profile`);
    console.log(`Skills: http://localhost:${PORT}/api/skills`);
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
