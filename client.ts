/**
 * Solo Empire API Client
 *
 * ใช้สำหรับดึงข้อมูลจาก Solo Empire Database
 * รองรับทั้ง local และ production (Cloudflare Tunnel)
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_SOLO_EMPIRE_API || 'http://localhost:3001';

export interface ExternalIntegration {
  id: string;
  name: string;
  icon: string;
  state: 'active' | 'paused';
  healthCheck: 'live' | 'paused';
  boundary: string;
}

export interface ExternalAppRecord {
  id: string;
  name: string;
  category: string;
  status: 'live' | 'mcp_only' | 'paused' | 'planned';
  apiDocs: string;
  note?: string;
}

export interface IntegrationHealthItem {
  id: string;
  name: string;
  icon: string;
  status: 'healthy' | 'not_configured' | 'error' | 'offline' | 'degraded' | 'unknown';
  detail?: string;
  error_class?: string;
}

export interface SentryIssueSummary {
  id: string;
  title: string;
  shortId?: string;
  status?: string;
  substatus?: string;
  level?: string;
  count?: string | number;
  userCount?: string | number;
  firstSeen?: string;
  lastSeen?: string;
  permalink?: string;
  project?: { slug?: string; name?: string };
}

export interface SentryIssuesReport {
  service: 'sentry';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  timestamp: string;
  issues: SentryIssueSummary[];
  organization?: string;
  limit?: number;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface PostHogInsightSummary {
  id: string | number;
  name: string;
  short_id?: string;
  derived_name?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  last_viewed_at?: string;
  last_refresh?: string;
  deleted?: boolean;
  favorited?: boolean;
  is_sample?: boolean;
  tags?: string[];
}

export interface PostHogInsightsReport {
  service: 'posthog';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  timestamp: string;
  insights: PostHogInsightSummary[];
  project_id?: string;
  limit?: number;
  returned?: number;
  total_count?: number;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  num_members?: number;
}

export interface SlackChannelsReport {
  service: 'slack';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  timestamp: string;
  channels: SlackChannelSummary[];
  workspace?: string;
  team_id?: string;
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface NotionSearchResult {
  id: string;
  object: string;
  created_time?: string;
  last_edited_time?: string;
  url?: string;
  public_url?: string;
  in_trash?: boolean;
  is_archived?: boolean;
  is_locked?: boolean;
  parent?: {
    type?: string;
    page_id?: string;
    database_id?: string;
    data_source_id?: string;
  };
  title?: string;
}

export interface NotionSearchReport {
  service: 'notion';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  timestamp: string;
  results: NotionSearchResult[];
  query?: string | null;
  version?: string;
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface AsanaWorkspaceSummary {
  gid: string;
  resource_type: string;
  name?: string;
  path?: string;
  uri?: string;
  is_organization?: boolean;
}

export interface AsanaProjectSummary {
  gid: string;
  resource_type: string;
  name?: string;
  permalink_url?: string;
  archived?: boolean;
  public?: boolean;
}

export interface AsanaReadOnlyReport {
  service: 'asana';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  resource: 'workspaces' | 'projects';
  timestamp: string;
  workspaces?: AsanaWorkspaceSummary[];
  projects?: AsanaProjectSummary[];
  workspace?: string | null;
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface LinearTeamSummary {
  id: string;
  name?: string;
  key?: string;
}

export interface LinearProjectSummary {
  id: string;
  name?: string;
}

export interface LinearReadOnlyReport {
  service: 'linear';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  resource: 'teams' | 'projects';
  timestamp: string;
  teams?: LinearTeamSummary[];
  projects?: LinearProjectSummary[];
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface DiscordGuildSummary {
  id: string;
  name?: string;
  icon?: string;
  owner?: boolean;
  features?: string[];
}

export interface DiscordGuildsReport {
  service: 'discord';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  resource: 'guilds';
  timestamp: string;
  guilds: DiscordGuildSummary[];
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface WhatsAppPhoneNumberSummary {
  id: string;
  verified_name?: string;
  display_phone_number_masked?: string;
  quality_rating?: string;
}

export interface WhatsAppBusinessReadOnlyReport {
  service: 'whatsapp-business';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  resource: 'phone-numbers';
  timestamp: string;
  phone_numbers: WhatsAppPhoneNumberSummary[];
  waba_id?: string;
  graph_api_version?: string;
  limit?: number;
  returned?: number;
  has_more?: boolean;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface MicrosoftGraphProfile {
  id: string;
  displayName?: string;
}

export interface MicrosoftGraphReadOnlyReport {
  service: 'microsoft-graph';
  status: 'healthy' | 'not_configured' | 'error' | 'offline';
  resource: 'me';
  timestamp: string;
  profile: MicrosoftGraphProfile;
  missing?: string[];
  error_class?: string;
  offline?: boolean;
}

export interface Profile {
  id: number;
  name: string | null;
  title: string | null;
  bio: string | null;
  tagline: string | null;
  location: string | null;
  email: string | null;
  website: string | null;
  avatar_url: string | null;
  header_image_url: string | null;
}

export interface SocialLink {
  id: number;
  platform: string;
  url: string;
  username: string | null;
  display_name: string | null;
  description: string | null;
  is_primary: boolean;
  sort_order: number;
}

export interface Skill {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  category_name: string | null;
  category_slug: string | null;
  level: string | null;
  target_level: string | null;
  status: string;
  priority: number;
  progress_percent: number;
  hours_invested: number;
}

export interface Asset {
  id: number;
  name: string;
  type: string;
  description: string | null;
  url: string | null;
  platform: string | null;
  status: string;
  monthly_value: number | null;
  total_value: number | null;
  views: number;
  subscribers: number;
  revenue: number;
}

export interface Content {
  id: number;
  title: string;
  slug: string;
  content_type: string;
  summary: string | null;
  body: string | null;
  status: string;
  published_at: string | null;
  platforms: string | null;
  canonical_url: string | null;
  views: number;
  shares: number;
}

class SoloEmpireAPI {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || API_BASE_URL;
  }

  private async fetch<T>(endpoint: string, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        headers,
        cache: 'no-store', // Always fetch fresh data
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try {
          const body = await response.json() as { error?: string };
          detail = body.error ? `: ${body.error}` : '';
        } catch {
          // Keep the status-only error when the server does not return JSON.
        }
        throw new Error(`API error: ${response.status}${detail}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to fetch ${endpoint}:`, error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * ดึงข้อมูล Profile + Social Links
   */
  async getProfile(): Promise<{ profile: Profile; socialLinks: SocialLink[] }> {
    return this.fetch('/api/profile');
  }

  /**
   * ดึง Skills ทั้งหมด (กรองตาม category/status ได้)
   */
  async getSkills(params?: { category?: string; status?: string }): Promise<{ skills: Skill[] }> {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.append('category', params.category);
    if (params?.status) queryParams.append('status', params.status);

    const query = queryParams.toString();
    return this.fetch(`/api/skills${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Skill เดียวตาม slug
   */
  async getSkill(slug: string): Promise<{ skill: Skill }> {
    return this.fetch(`/api/skills/${slug}`);
  }

  /**
   * ดึง Assets ทั้งหมด
   */
  async getAssets(params?: { type?: string; status?: string }): Promise<{ assets: Asset[] }> {
    const queryParams = new URLSearchParams();
    if (params?.type) queryParams.append('type', params.type);
    if (params?.status) queryParams.append('status', params.status);

    const query = queryParams.toString();
    return this.fetch(`/api/assets${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Content ที่ publish แล้ว
   */
  async getContent(params?: { type?: string; limit?: number }): Promise<{ content: Content[] }> {
    const queryParams = new URLSearchParams();
    if (params?.type) queryParams.append('type', params.type);
    if (params?.limit) queryParams.append('limit', params.limit.toString());

    const query = queryParams.toString();
    return this.fetch(`/api/content${query ? `?${query}` : ''}`);
  }

  /**
   * ดึง Content เดียวตาม slug
   */
  async getContentBySlug(slug: string): Promise<{ content: Content }> {
    return this.fetch(`/api/content/${slug}`);
  }

  async getIntegrations(): Promise<{
    source: string;
    total_apps: number;
    status_counts: Record<string, number>;
    apps: ExternalAppRecord[];
    integrations: ExternalIntegration[];
  }> {
    return this.fetch('/api/integrations');
  }

  async getIntegrationHealth(options: { token: string; offline?: boolean }): Promise<{
    timestamp: string;
    total_integrations: number;
    healthy: number;
    not_configured: number;
    errors: number;
    integrations: IntegrationHealthItem[];
  }> {
    const query = options.offline ? '?offline=true' : '';
    return this.fetch(`/api/integrations/health${query}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getSentryIssues(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<SentryIssuesReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/sentry/issues?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getPostHogInsights(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<PostHogInsightsReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/posthog/insights?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getSlackChannels(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<SlackChannelsReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/slack/channels?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async searchNotion(options: {
    token: string;
    query?: string;
    limit?: number;
    offline?: boolean;
  }): Promise<NotionSearchReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.query) params.set('query', options.query);
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/notion/search?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getAsanaWorkspaces(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<AsanaReadOnlyReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/asana/workspaces?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getAsanaProjects(options: {
    token: string;
    workspace: string;
    limit?: number;
    offline?: boolean;
  }): Promise<AsanaReadOnlyReport> {
    const params = new URLSearchParams({
      workspace: options.workspace,
      limit: String(options.limit || 20),
    });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/asana/projects?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getLinearTeams(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<LinearReadOnlyReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/linear/teams?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getLinearProjects(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<LinearReadOnlyReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/linear/projects?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getDiscordGuilds(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<DiscordGuildsReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/discord/guilds?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getWhatsAppBusinessPhoneNumbers(options: {
    token: string;
    limit?: number;
    offline?: boolean;
  }): Promise<WhatsAppBusinessReadOnlyReport> {
    const params = new URLSearchParams({ limit: String(options.limit || 20) });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/whatsapp-business/phone-numbers?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async getMicrosoftGraphProfile(options: {
    token: string;
    offline?: boolean;
  }): Promise<MicrosoftGraphReadOnlyReport> {
    const params = new URLSearchParams();
    if (options.offline) params.set('offline', 'true');
    const query = params.toString();
    return this.fetch(`/api/integrations/microsoft-graph/me${query ? `?${query}` : ''}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  async discoverExternalApps(options: {
    token: string;
    source?: 'apis-guru' | 'mcp-registry' | 'all';
    limit?: number;
    offline?: boolean;
  }): Promise<{
    schema_version: string;
    source: string;
    limit: number;
    total_discovered: number;
    partial?: boolean;
    items: Array<{
      id: string;
      name: string;
      source: string;
      status: string;
      category: string;
      api_spec_url?: string;
    }>;
  }> {
    const params = new URLSearchParams({
      source: options.source || 'all',
      limit: String(options.limit || 1000),
    });
    if (options.offline) params.set('offline', 'true');
    return this.fetch(`/api/integrations/discovery?${params.toString()}`, {
      Authorization: `Bearer ${options.token}`,
    });
  }

  /**
   * ตรวจสอบว่า API ทำงานอยู่ไหม
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const soloEmpireAPI = new SoloEmpireAPI();

// Export class for custom instances
export { SoloEmpireAPI };
