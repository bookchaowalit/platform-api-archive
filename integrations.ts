export type IntegrationHealthStatus =
  | 'healthy'
  | 'not_configured'
  | 'error'
  | 'offline'
  | 'degraded'
  | 'unknown';

export interface ExternalIntegrationDescriptor {
  id: string;
  name: string;
  icon: string;
  state: 'active' | 'paused';
  healthCheck: 'live' | 'paused';
  boundary: string;
}

/** Direct external API boundaries checked by integration_health.py. */
export const EXTERNAL_INTEGRATIONS: ExternalIntegrationDescriptor[] = [
  { id: 'google-calendar', name: 'Google Calendar', icon: '📅', state: 'active', healthCheck: 'live', boundary: 'google-oauth' },
  { id: 'gmail', name: 'Gmail', icon: '📧', state: 'active', healthCheck: 'live', boundary: 'google-oauth' },
  { id: 'google-drive', name: 'Google Drive', icon: '📁', state: 'active', healthCheck: 'live', boundary: 'google-oauth' },
  { id: 'github', name: 'GitHub', icon: '🐙', state: 'active', healthCheck: 'live', boundary: 'github' },
  { id: 'cloudflare', name: 'Cloudflare', icon: '☁️', state: 'active', healthCheck: 'live', boundary: 'cloudflare' },
  { id: 'vercel', name: 'Vercel', icon: '▲', state: 'active', healthCheck: 'live', boundary: 'vercel' },
  { id: 'telegram', name: 'Telegram', icon: '✈️', state: 'active', healthCheck: 'live', boundary: 'telegram' },
  { id: 'line', name: 'LINE Official Account', icon: '💬', state: 'active', healthCheck: 'live', boundary: 'line-messaging-api' },
  { id: 'stripe', name: 'Stripe', icon: '💳', state: 'active', healthCheck: 'live', boundary: 'stripe-payments-api' },
  { id: 'sentry', name: 'Sentry', icon: '🛡️', state: 'active', healthCheck: 'live', boundary: 'sentry-observability-api' },
  { id: 'posthog', name: 'PostHog', icon: '📊', state: 'active', healthCheck: 'live', boundary: 'posthog-analytics-api' },
  { id: 'slack', name: 'Slack', icon: '💬', state: 'active', healthCheck: 'live', boundary: 'slack-messaging-api' },
  { id: 'notion', name: 'Notion', icon: '⬛', state: 'active', healthCheck: 'live', boundary: 'notion-search-api' },
  { id: 'asana', name: 'Asana', icon: '🟣', state: 'active', healthCheck: 'live', boundary: 'asana-projects-api' },
  { id: 'linear', name: 'Linear', icon: '📐', state: 'active', healthCheck: 'live', boundary: 'linear-graphql-api' },
  { id: 'discord', name: 'Discord', icon: '🎮', state: 'active', healthCheck: 'live', boundary: 'discord-guilds-api' },
  { id: 'whatsapp-business', name: 'WhatsApp Business', icon: '🟢', state: 'active', healthCheck: 'live', boundary: 'whatsapp-business-api' },
  { id: 'microsoft-graph', name: 'Microsoft Graph', icon: '🔷', state: 'active', healthCheck: 'live', boundary: 'microsoft-graph-user-api' },
  { id: 'leantime', name: 'Leantime', icon: '📋', state: 'active', healthCheck: 'live', boundary: 'remote-mcp' },
  { id: 'todoist', name: 'Todoist', icon: '✅', state: 'active', healthCheck: 'live', boundary: 'todoist' },
  { id: 'strava', name: 'Strava', icon: '🏃', state: 'paused', healthCheck: 'paused', boundary: 'strava' },
  { id: 'binance-th', name: 'Binance TH', icon: '📈', state: 'paused', healthCheck: 'paused', boundary: 'binance-th' },
];

const ID_BY_NAME = new Map(EXTERNAL_INTEGRATIONS.map((item) => [item.name, item.id]));
const ALLOWED_STATUSES = new Set<IntegrationHealthStatus>([
  'healthy', 'not_configured', 'error', 'offline', 'degraded', 'unknown',
]);

export interface SanitizedIntegrationHealth {
  id: string;
  name: string;
  icon: string;
  status: IntegrationHealthStatus;
  detail?: string;
  error_class?: string;
}

/** Remove credential-shaped fields and keep the REST response stable. */
export function sanitizeIntegrationHealth(payload: any): {
  timestamp: string;
  total_integrations: number;
  healthy: number;
  not_configured: number;
  errors: number;
  integrations: SanitizedIntegrationHealth[];
  data_freshness: Record<string, { last_sync: string | null; stale: boolean }>;
} {
  if (!payload || !Array.isArray(payload.integrations)) {
    throw new Error('Invalid integration health payload');
  }

  const integrations = payload.integrations.map((item: any) => {
    const status = ALLOWED_STATUSES.has(item?.status) ? item.status : 'unknown';
    const sanitized: SanitizedIntegrationHealth = {
      id: ID_BY_NAME.get(item?.name) || 'unknown',
      name: typeof item?.name === 'string' ? item.name : 'Unknown integration',
      icon: typeof item?.icon === 'string' ? item.icon : '🔌',
      status,
    };
    if (typeof item?.detail === 'string') sanitized.detail = item.detail;
    if (typeof item?.error_class === 'string') sanitized.error_class = item.error_class;
    return sanitized;
  });

  const dataFreshness: Record<string, { last_sync: string | null; stale: boolean }> = {};
  if (payload.data_freshness && typeof payload.data_freshness === 'object') {
    for (const [name, value] of Object.entries(payload.data_freshness as Record<string, any>)) {
      dataFreshness[name] = {
        last_sync: typeof value?.last_sync === 'string' ? value.last_sync : null,
        stale: Boolean(value?.stale),
      };
    }
  }

  return {
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
    total_integrations: integrations.length,
    healthy: integrations.filter((item) => item.status === 'healthy').length,
    not_configured: integrations.filter((item) => item.status === 'not_configured').length,
    errors: integrations.filter((item) => item.status === 'error').length,
    integrations,
    data_freshness: dataFreshness,
  };
}
import { EXTERNAL_APP_REGISTRY } from './external_app_registry.js';

export { EXTERNAL_APP_REGISTRY } from './external_app_registry.js';
