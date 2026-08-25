/**
 * Redacted audit events for the BookFinance API boundary.
 *
 * The audit record is deliberately metadata-only: no bearer token, query
 * values, response body, account details, or source payloads are persisted.
 */

import { randomUUID } from 'crypto';

type AuditDb = {
  prepare: (sql: string) => { run: (...args: any[]) => unknown };
};

export type FinanceApiAuditEvent = {
  method: string;
  route: string;
  status: number;
  authorized: boolean;
  subject: string | null;
  scopes: string[];
  requiredScope: string;
  queryKeys: string[];
};

export function newFinanceApiRequestId(): string {
  return randomUUID();
}

export function recordFinanceApiAudit(
  db: AuditDb,
  requestId: string,
  event: FinanceApiAuditEvent,
): void {
  const action = event.status >= 400 ? 'api_read_rejected' : 'api_read';
  const details = JSON.stringify({
    schema_version: 'finance.v1',
    service: 'book-finance-api',
    request_id: requestId,
    method: event.method,
    route: event.route,
    status: event.status,
    authorized: event.authorized,
    subject: event.subject,
    scopes: [...new Set(event.scopes)].sort(),
    required_scope: event.requiredScope,
    query_keys: [...new Set(event.queryKeys)].sort(),
  });

  try {
    db.prepare(`
      INSERT INTO audit_log
        (user_id, action, target_type, target_id, details, ip_address, user_agent)
      VALUES (NULL, ?, 'finance_api', NULL, ?, NULL, NULL)
    `).run(action, details);
  } catch (error) {
    // Audit persistence must not turn a read-only projection into an outage.
    // Keep the failure metadata-only and never print request headers or body.
    console.error('[finance-api-audit] unable to persist redacted audit event', error);
  }
}
