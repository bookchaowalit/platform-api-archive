/**
 * BookFinance API v1 read boundary.
 *
 * This module owns only the HTTP-facing read model. The SQLite finance tables
 * remain the operational source of truth; callers must not receive raw
 * metadata/evidence fields or write through this boundary.
 */

type Query = {
  all: (...args: any[]) => any[];
  get: (...args: any[]) => any;
};

type FinanceDb = {
  prepare: (sql: string) => Query;
};

export type FinanceApiResponse = {
  status: number;
  body: Record<string, unknown>;
};

const SCHEMA_VERSION = 'finance.v1';
const SERVICE = 'book-finance-api';
const MAX_LIMIT = 100;
const STATUSES = new Set(['draft', 'sent', 'paid', 'overdue', 'cancelled']);
const ACCOUNT_STATUSES = new Set(['planned', 'active', 'paused', 'closed']);

function errorResponse(status: number, error: string): FinanceApiResponse {
  return { status, body: { error, schema_version: SCHEMA_VERSION } };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateRange(url: URL): { clause: string; args: string[] } | FinanceApiResponse {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && !validDate(from)) return errorResponse(400, 'from must use a valid YYYY-MM-DD date');
  if (to && !validDate(to)) return errorResponse(400, 'to must use a valid YYYY-MM-DD date');
  if (from && to && from > to) return errorResponse(400, 'from must be before or equal to to');

  const clauses: string[] = [];
  const args: string[] = [];
  if (from) {
    clauses.push('transaction_date >= ?');
    args.push(from);
  }
  if (to) {
    clauses.push('transaction_date <= ?');
    args.push(to);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
}

function summaryRange(url: URL): { clause: string; args: string[]; period: string | null } | FinanceApiResponse {
  const period = url.searchParams.get('period');
  if (!period) return { clause: '', args: [], period: null };
  if (!/^\d{4}-\d{2}$/.test(period)) return errorResponse(400, 'period must use YYYY-MM format');

  const [year, month] = period.split('-').map(Number);
  if (month < 1 || month > 12) return errorResponse(400, 'period must contain a valid month');
  const start = `${period}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    clause: ' AND transaction_date >= ? AND transaction_date < ?',
    args: [start, `${nextMonth}-01`],
    period,
  };
}

function pagination(url: URL): { limit: number; offset: number } | FinanceApiResponse {
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return errorResponse(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (!Number.isInteger(offset) || offset < 0) return errorResponse(400, 'offset must be a non-negative integer');
  return { limit, offset };
}

function pagedItems(items: any[], limit: number, offset: number): Record<string, unknown> {
  return {
    items,
    limit,
    offset,
    next_cursor: items.length === limit ? String(offset + items.length) : null,
  };
}

function summary(db: FinanceDb, url: URL): FinanceApiResponse {
  const range = summaryRange(url);
  if ('status' in range) return range;

  const transactions = db.prepare(`
    SELECT currency,
           COUNT(*) AS count,
           COALESCE(SUM(CASE WHEN transaction_type = 'income' THEN amount ELSE 0 END), 0) AS income,
           COALESCE(SUM(CASE WHEN transaction_type = 'expense' THEN amount ELSE 0 END), 0) AS expense
    FROM financial_transactions
    WHERE 1 = 1${range.clause}
    GROUP BY currency
    ORDER BY currency
  `).all(...range.args).map((row: any) => ({
    currency: row.currency,
    count: row.count,
    income: row.income,
    expense: row.expense,
    net: Number(row.income) - Number(row.expense),
  }));

  const revenue = db.prepare(`
    SELECT currency,
           COUNT(*) AS count,
           COALESCE(SUM(amount), 0) AS total,
           COALESCE(SUM(CASE WHEN received = 1 THEN amount ELSE 0 END), 0) AS received,
           COALESCE(SUM(CASE WHEN received = 0 THEN amount ELSE 0 END), 0) AS pending
    FROM revenue
    WHERE 1 = 1${range.clause.replaceAll('transaction_date', 'revenue_date')}
    GROUP BY currency
    ORDER BY currency
  `).all(...range.args);

  const invoices = db.prepare(`
    SELECT status, currency, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
    FROM invoices
    WHERE 1 = 1${range.clause.replaceAll('transaction_date', 'issue_date')}
    GROUP BY status, currency
    ORDER BY currency, status
  `).all(...range.args);

  const accounts = db.prepare(`SELECT COUNT(*) AS count FROM finance_accounts WHERE status = 'active'`).get();
  const liabilities = db.prepare(`
    SELECT currency, COUNT(*) AS count, COALESCE(SUM(outstanding_amount), 0) AS outstanding
    FROM finance_liabilities
    WHERE status IN ('planned', 'active', 'overdue')
    GROUP BY currency
    ORDER BY currency
  `).all();

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      period: range.period,
      source_of_truth: 'sqlite.finance_control_plane',
      transactions,
      revenue,
      invoices,
      accounts: { active: accounts?.count ?? 0 },
      liabilities,
    },
  };
}

function transactions(db: FinanceDb, url: URL): FinanceApiResponse {
  const range = dateRange(url);
  if ('status' in range) return range;
  const page = pagination(url);
  if ('status' in page) return page;

  const filters: string[] = [];
  const args: any[] = [...range.args];
  for (const [parameter, column] of [
    ['type', 'transaction_type'],
    ['category', 'category'],
    ['currency', 'currency'],
  ] as const) {
    const value = url.searchParams.get(parameter);
    if (value) {
      if (value.length > 80) return errorResponse(400, `${parameter} is too long`);
      filters.push(` AND ${column} = ?`);
      args.push(value);
    }
  }

  const items = db.prepare(`
    SELECT id, source, transaction_type, amount, currency, description,
           category, merchant, transaction_date, account, account_id,
           subscription_id, created_at
    FROM financial_transactions
    WHERE 1 = 1${range.clause}${filters.join('')}
    ORDER BY transaction_date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.financial_transactions',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

function accounts(db: FinanceDb, url: URL): FinanceApiResponse {
  const page = pagination(url);
  if ('status' in page) return page;
  const status = url.searchParams.get('status');
  if (status && !ACCOUNT_STATUSES.has(status)) return errorResponse(400, 'status is not a valid finance account status');

  const args: any[] = [];
  const statusClause = status ? ' AND status = ?' : '';
  if (status) args.push(status);
  const items = db.prepare(`
    SELECT id, name, account_type, owner_scope, currency, status,
           opening_balance, opened_on, closed_on, created_at, updated_at
    FROM finance_accounts
    WHERE 1 = 1${statusClause}
    ORDER BY name, id
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.finance_accounts',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

function invoices(db: FinanceDb, url: URL): FinanceApiResponse {
  const range = dateRange(url);
  if ('status' in range) return range;
  const page = pagination(url);
  if ('status' in page) return page;
  const status = url.searchParams.get('status');
  if (status && !STATUSES.has(status)) return errorResponse(400, 'status is not a valid invoice status');

  const args: any[] = [...range.args];
  const statusClause = status ? ' AND status = ?' : '';
  if (status) args.push(status);
  const items = db.prepare(`
    SELECT id, invoice_no, amount, currency, issue_date, due_date, paid_date,
           status, description, revenue_id, created_at, updated_at
    FROM invoices
    WHERE 1 = 1${range.clause.replaceAll('transaction_date', 'issue_date')}${statusClause}
    ORDER BY issue_date DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.invoices',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

export function financeApiResponse(db: FinanceDb, url: URL, method: string): FinanceApiResponse | null {
  if (url.pathname !== '/api/finance/v1' && !url.pathname.startsWith('/api/finance/v1/')) return null;
  if (method !== 'GET') return errorResponse(405, 'BookFinance API v1 is read-only');

  switch (url.pathname) {
    case '/api/finance/v1':
      return {
        status: 200,
        body: {
          schema_version: SCHEMA_VERSION,
          service: SERVICE,
          status: 'active',
          auth: 'bearer',
          read_only: true,
          endpoints: [
            '/api/finance/v1/summary',
            '/api/finance/v1/transactions',
            '/api/finance/v1/accounts',
            '/api/finance/v1/invoices',
          ],
        },
      };
    case '/api/finance/v1/summary':
      return summary(db, url);
    case '/api/finance/v1/transactions':
      return transactions(db, url);
    case '/api/finance/v1/accounts':
      return accounts(db, url);
    case '/api/finance/v1/invoices':
      return invoices(db, url);
    default:
      return errorResponse(404, 'BookFinance API endpoint not found');
  }
}
