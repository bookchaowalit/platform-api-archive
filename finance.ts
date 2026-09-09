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
const INVESTMENT_STATUSES = new Set(['planned', 'active', 'sold', 'closed']);
const INVESTMENT_TYPES = new Set(['stock', 'etf', 'fund', 'bond', 'crypto', 'real_estate', 'business', 'other']);
const RECONCILIATION_STATUSES = new Set(['open', 'matched', 'exception', 'closed']);
const RECONCILIATION_SOURCE_TYPES = new Set(['bank_statement', 'wallet_export', 'invoice_register', 'manual', 'other']);
const VALUATION_COVERAGE_STATUSES = new Set(['covered', 'partial', 'unpriced', 'stale', 'invalid']);
const RISK_POLICY_VERSION = 'finance-risk-input-policy.v1';
const RISK_METRIC_DEFINITIONS_VERSION = 'finance-risk-metric-definitions.v1';
const RISK_METRIC_DEFINITIONS_STATUS = 'approved_contract_baseline';
const RISK_FX_CONTRACT_VERSION = 'finance.fx-snapshot.v1';
const RISK_FX_CONTRACT_STATUS = 'approved-contract-baseline';
const RISK_FX_POLICY = 'single_currency_only';
const RISK_FRESHNESS_MAX_AGE_HOURS: Record<string, number> = {
  exchange: 24,
  broker: 24,
  custodian: 24,
  manual: 168,
  derived: 24,
};
const RISK_METRIC_STATUSES = {
  volatility: 'not_enabled',
  concentration: 'not_enabled',
  liquidity: 'not_enabled',
  drawdown: 'not_enabled',
} as const;

function errorResponse(status: number, error: string): FinanceApiResponse {
  return { status, body: { error, schema_version: SCHEMA_VERSION } };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
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

function reconciliationRange(url: URL): { clause: string; args: string[] } | FinanceApiResponse {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from && !validDate(from)) return errorResponse(400, 'from must use a valid YYYY-MM-DD date');
  if (to && !validDate(to)) return errorResponse(400, 'to must use a valid YYYY-MM-DD date');
  if (from && to && from > to) return errorResponse(400, 'from must be before or equal to to');

  const clauses: string[] = [];
  const args: string[] = [];
  if (from) {
    clauses.push('period_end >= ?');
    args.push(from);
  }
  if (to) {
    clauses.push('period_start <= ?');
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

function investments(db: FinanceDb, url: URL): FinanceApiResponse {
  const page = pagination(url);
  if ('status' in page) return page;

  const filters: string[] = [];
  const args: any[] = [];
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  const currency = url.searchParams.get('currency');

  if (status && !INVESTMENT_STATUSES.has(status)) {
    return errorResponse(400, 'status is not a valid finance investment status');
  }
  if (type && !INVESTMENT_TYPES.has(type)) {
    return errorResponse(400, 'type is not a valid finance investment type');
  }
  if (currency && currency.length > 12) return errorResponse(400, 'currency is too long');
  if (status) {
    filters.push(' AND status = ?');
    args.push(status);
  }
  if (type) {
    filters.push(' AND investment_type = ?');
    args.push(type);
  }
  if (currency) {
    filters.push(' AND currency = ?');
    args.push(currency);
  }

  const items = db.prepare(`
    SELECT id, name, investment_type, owner_scope, account_id, quantity,
           cost_basis, current_value, currency, acquired_on, status
    FROM finance_investments
    WHERE 1 = 1${filters.join('')}
    ORDER BY status, name, id
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.finance_investments',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

function reconciliations(db: FinanceDb, url: URL): FinanceApiResponse {
  const range = reconciliationRange(url);
  if ('status' in range) return range;
  const page = pagination(url);
  if ('status' in page) return page;

  const filters: string[] = [];
  const args: any[] = [...range.args];
  const status = url.searchParams.get('status');
  const sourceType = url.searchParams.get('source_type');
  const currency = url.searchParams.get('currency');

  if (status && !RECONCILIATION_STATUSES.has(status)) {
    return errorResponse(400, 'status is not a valid finance reconciliation status');
  }
  if (sourceType && !RECONCILIATION_SOURCE_TYPES.has(sourceType)) {
    return errorResponse(400, 'source_type is not a valid finance reconciliation source type');
  }
  if (currency && currency.length > 12) return errorResponse(400, 'currency is too long');
  if (status) {
    filters.push(' AND status = ?');
    args.push(status);
  }
  if (sourceType) {
    filters.push(' AND source_type = ?');
    args.push(sourceType);
  }
  if (currency) {
    filters.push(' AND currency = ?');
    args.push(currency);
  }

  const items = db.prepare(`
    SELECT id, account_id, period_start, period_end, source_type,
           expected_amount, reconciled_amount, difference_amount,
           currency, status, reconciled_at
    FROM finance_reconciliations
    WHERE 1 = 1${range.clause}${filters.join('')}
    ORDER BY period_end DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.finance_reconciliations',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

function valuations(db: FinanceDb, url: URL): FinanceApiResponse {
  const page = pagination(url);
  if ('status' in page) return page;

  const filters: string[] = [];
  const args: any[] = [];
  const investmentId = url.searchParams.get('investment_id');
  const coverageStatus = url.searchParams.get('coverage_status');
  const currency = url.searchParams.get('currency');
  const investmentStatus = url.searchParams.get('status');
  const latestOnly = url.searchParams.get('latest');

  if (investmentId) {
    const parsed = Number(investmentId);
    if (!Number.isInteger(parsed) || parsed < 1) return errorResponse(400, 'investment_id must be a positive integer');
    filters.push(' AND v.investment_id = ?');
    args.push(parsed);
  }
  if (coverageStatus && !VALUATION_COVERAGE_STATUSES.has(coverageStatus)) {
    return errorResponse(400, 'coverage_status is not a valid finance valuation coverage status');
  }
  if (currency && currency.length > 12) return errorResponse(400, 'currency is too long');
  if (investmentStatus && !INVESTMENT_STATUSES.has(investmentStatus)) {
    return errorResponse(400, 'status is not a valid finance investment status');
  }
  if (latestOnly && latestOnly !== 'true' && latestOnly !== 'false') {
    return errorResponse(400, 'latest must be true or false');
  }
  if (coverageStatus) {
    filters.push(' AND v.coverage_status = ?');
    args.push(coverageStatus);
  }
  if (currency) {
    filters.push(' AND v.currency = ?');
    args.push(currency);
  }
  if (investmentStatus) {
    filters.push(' AND i.status = ?');
    args.push(investmentStatus);
  }
  if (latestOnly === 'true') {
    filters.push(`
      AND NOT EXISTS (
        SELECT 1
        FROM finance_valuation_snapshots newer
        WHERE newer.investment_id = v.investment_id
          AND newer.currency = v.currency
          AND (
            newer.valuation_as_of > v.valuation_as_of
            OR (newer.valuation_as_of = v.valuation_as_of AND newer.id > v.id)
          )
      )
    `);
  }

  const items = db.prepare(`
    SELECT v.id, v.investment_id, i.name AS investment_name,
           v.market_price_snapshot_id, v.quantity, v.market_value,
           v.currency, v.valuation_as_of, v.valuation_method,
           v.coverage_status,
           p.price AS market_price,
           p.currency AS market_price_currency,
           p.as_of AS market_price_as_of,
           p.source_type AS market_price_source_type,
           p.quality AS market_price_quality
    FROM finance_valuation_snapshots v
    JOIN finance_investments i ON i.id = v.investment_id
    LEFT JOIN finance_market_price_snapshots p ON p.id = v.market_price_snapshot_id
    WHERE 1 = 1${filters.join('')}
    ORDER BY v.valuation_as_of DESC, v.id DESC
    LIMIT ? OFFSET ?
  `).all(...args, page.limit, page.offset);

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.finance_valuation_snapshots',
      ...pagedItems(items, page.limit, page.offset),
    },
  };
}

function riskReadiness(db: FinanceDb, url: URL): FinanceApiResponse {
  const requestedCurrency = url.searchParams.get('currency');
  const requestedAsOf = url.searchParams.get('as_of');
  const evaluationAsOf = requestedAsOf || new Date().toISOString();

  if (requestedCurrency && requestedCurrency.length > 12) return errorResponse(400, 'currency is too long');
  if (requestedAsOf && !validUtcTimestamp(requestedAsOf)) {
    return errorResponse(400, 'as_of must use a valid UTC ISO-8601 timestamp');
  }

  const positionArgs: any[] = [];
  const positionCurrencyClause = requestedCurrency ? ' AND currency = ?' : '';
  if (requestedCurrency) positionArgs.push(requestedCurrency);
  const positions = db.prepare(`
    SELECT id, currency
    FROM finance_investments
    WHERE status = 'active'${positionCurrencyClause}
    ORDER BY id
  `).all(...positionArgs);

  const valuationArgs: any[] = [];
  const valuationCurrencyClause = requestedCurrency ? ' AND i.currency = ?' : '';
  if (requestedCurrency) valuationArgs.push(requestedCurrency);
  const valuationRows = db.prepare(`
    SELECT v.id, v.investment_id, v.market_value, v.currency,
           v.valuation_as_of, v.coverage_status,
           p.as_of AS market_price_as_of,
           p.source_type AS market_price_source_type,
           p.quality AS market_price_quality
    FROM finance_valuation_snapshots v
    JOIN finance_investments i ON i.id = v.investment_id AND i.status = 'active'
    LEFT JOIN finance_market_price_snapshots p ON p.id = v.market_price_snapshot_id
    WHERE 1 = 1${valuationCurrencyClause}
    ORDER BY v.investment_id, v.valuation_as_of DESC, v.id DESC
  `).all(...valuationArgs);

  const latestByInvestment = new Map<number, any>();
  for (const row of valuationRows) {
    if (!latestByInvestment.has(Number(row.investment_id))) latestByInvestment.set(Number(row.investment_id), row);
  }

  const currencies = [...new Set(positions.map((row: any) => String(row.currency)))];
  const selectedCurrency = requestedCurrency || (currencies.length > 1 ? 'MIXED' : currencies[0] || 'THB');
  const reasonCodes: string[] = [];
  const totalPositions = positions.length;
  let eligiblePositions = 0;
  let stalePositions = 0;
  let unverifiedPositions = 0;
  let missingPositions = 0;
  let latestValuationAsOf: string | null = null;

  for (const position of positions) {
    const valuation = latestByInvestment.get(Number(position.id));
    if (!valuation) {
      missingPositions += 1;
      continue;
    }

    const valuationAsOf = String(valuation.valuation_as_of);
    if (!latestValuationAsOf || valuationAsOf > latestValuationAsOf) latestValuationAsOf = valuationAsOf;
    const marketPriceQuality = valuation.market_price_quality ? String(valuation.market_price_quality) : null;
    const sourceType = valuation.market_price_source_type ? String(valuation.market_price_source_type) : null;
    const freshnessTimestamp = valuation.market_price_as_of || valuation.valuation_as_of;
    const freshnessAgeHours = (Date.parse(evaluationAsOf) - Date.parse(String(freshnessTimestamp))) / (1000 * 60 * 60);
    const maxAgeHours = RISK_FRESHNESS_MAX_AGE_HOURS[sourceType || ''] || 24;
    const stale =
      !validUtcTimestamp(valuationAsOf) ||
      !valuation.market_price_as_of ||
      !validUtcTimestamp(String(valuation.market_price_as_of)) ||
      freshnessAgeHours > maxAgeHours;
    const unverified = marketPriceQuality !== 'verified';
    if (stale || valuation.coverage_status === 'stale') stalePositions += 1;
    if (unverified) unverifiedPositions += 1;

    if (
      valuation.coverage_status === 'covered' &&
      valuation.market_value !== null &&
      Boolean(valuation.market_price_as_of) &&
      !stale &&
      !unverified
    ) {
      eligiblePositions += 1;
    }
  }

  if (totalPositions === 0 || latestByInvestment.size === 0) reasonCodes.push('NO_VALUATION_SNAPSHOTS');
  if (totalPositions > 0 && eligiblePositions < totalPositions) reasonCodes.push('INCOMPLETE_COVERAGE');
  if (stalePositions > 0) reasonCodes.push('STALE_VALUATION');
  if (unverifiedPositions > 0) reasonCodes.push('UNVERIFIED_PRICE_QUALITY');
  if (currencies.length > 1) reasonCodes.push('MULTI_CURRENCY_FX_UNAVAILABLE');
  reasonCodes.push('RISK_METRICS_NOT_ENABLED');

  return {
    status: 200,
    body: {
      schema_version: SCHEMA_VERSION,
      service: SERVICE,
      source_of_truth: 'sqlite.finance_control_plane.finance_valuation_snapshots',
      contract_version: 'finance.valuation-risk.v1',
      policy_version: RISK_POLICY_VERSION,
      metric_definitions_version: RISK_METRIC_DEFINITIONS_VERSION,
      metric_definitions_status: RISK_METRIC_DEFINITIONS_STATUS,
      fx_contract_version: RISK_FX_CONTRACT_VERSION,
      fx_contract_status: RISK_FX_CONTRACT_STATUS,
      status: 'blocked',
      risk_engine_enabled: false,
      evaluation_as_of: evaluationAsOf,
      currency: selectedCurrency,
      total_positions: totalPositions,
      eligible_positions: eligiblePositions,
      coverage_ratio: totalPositions ? eligiblePositions / totalPositions : 0,
      stale_positions: stalePositions,
      unverified_positions: unverifiedPositions,
      missing_positions: missingPositions,
      latest_valuation_as_of: latestValuationAsOf,
      freshness_max_age_hours: RISK_FRESHNESS_MAX_AGE_HOURS,
      fx_policy: RISK_FX_POLICY,
      metrics: RISK_METRIC_STATUSES,
      reason_codes: reasonCodes,
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
            '/api/finance/v1/investments',
            '/api/finance/v1/reconciliations',
            '/api/finance/v1/valuations',
            '/api/finance/v1/risk-readiness',
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
    case '/api/finance/v1/investments':
      return investments(db, url);
    case '/api/finance/v1/reconciliations':
      return reconciliations(db, url);
    case '/api/finance/v1/valuations':
      return valuations(db, url);
    case '/api/finance/v1/risk-readiness':
      return riskReadiness(db, url);
    case '/api/finance/v1/invoices':
      return invoices(db, url);
    default:
      return errorResponse(404, 'BookFinance API endpoint not found');
  }
}
