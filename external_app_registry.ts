export type ExternalAppStatus = 'live' | 'mcp_only' | 'paused' | 'planned';

export interface ExternalAppRecord {
  id: string;
  name: string;
  category: string;
  status: ExternalAppStatus;
  apiDocs: string;
  note?: string;
}

/**
 * Discovery registry for external apps worth connecting to Solo Empire.
 *
 * `live` means the direct health checker already supports the provider.
 * `mcp_only` means an MCP connector exists but this REST API does not proxy it.
 * `paused` is intentionally disabled. `planned` is inventory only until a
 * credential contract, data contract, sync boundary, and focused test exist.
 */
export const EXTERNAL_APP_REGISTRY: ExternalAppRecord[] = [
  // Existing direct integrations and MCP boundaries (16)
  { id: 'google-calendar', name: 'Google Calendar', category: 'productivity', status: 'live', apiDocs: 'https://developers.google.com/calendar/api' },
  { id: 'gmail', name: 'Gmail', category: 'communication', status: 'live', apiDocs: 'https://developers.google.com/gmail/api' },
  { id: 'google-drive', name: 'Google Drive', category: 'storage', status: 'live', apiDocs: 'https://developers.google.com/drive/api' },
  { id: 'github', name: 'GitHub', category: 'developer', status: 'live', apiDocs: 'https://docs.github.com/en/rest' },
  { id: 'cloudflare', name: 'Cloudflare', category: 'infrastructure', status: 'live', apiDocs: 'https://developers.cloudflare.com/api/' },
  { id: 'vercel', name: 'Vercel', category: 'infrastructure', status: 'live', apiDocs: 'https://vercel.com/docs/rest-api' },
  { id: 'render', name: 'Render', category: 'infrastructure', status: 'live', apiDocs: 'https://render.com/docs/api', note: 'Read-only service API health' },
  { id: 'railway', name: 'Railway', category: 'infrastructure', status: 'live', apiDocs: 'https://docs.railway.com/integrations/api', note: 'Read-only GraphQL API health' },
  { id: 'fly-io', name: 'Fly.io', category: 'infrastructure', status: 'live', apiDocs: 'https://fly.io/docs/machines/api/', note: 'Read-only Machines API health; requires FLY_ORG_SLUG for live app summary' },
  { id: 'heroku', name: 'Heroku', category: 'infrastructure', status: 'live', apiDocs: 'https://devcenter.heroku.com/articles/platform-api-reference', note: 'Read-only Platform API account health' },
  { id: 'telegram', name: 'Telegram', category: 'communication', status: 'live', apiDocs: 'https://core.telegram.org/bots/api' },
  { id: 'leantime', name: 'Leantime', category: 'project-management', status: 'live', apiDocs: 'https://mcp.project.cocofriday.com/mcp' },
  { id: 'todoist', name: 'Todoist', category: 'productivity', status: 'live', apiDocs: 'https://developer.todoist.com/rest/v2/' },
  { id: 'strava', name: 'Strava', category: 'health', status: 'paused', apiDocs: 'https://developers.strava.com/docs/reference/' },
  { id: 'binance-th', name: 'Binance TH', category: 'finance', status: 'paused', apiDocs: 'https://www.binance.th/api-docs/en/' },
  { id: 'notion', name: 'Notion', category: 'knowledge', status: 'live', apiDocs: 'https://developers.notion.com/' },
  { id: 'supabase', name: 'Supabase', category: 'database', status: 'mcp_only', apiDocs: 'https://supabase.com/docs/reference' },
  { id: 'stripe', name: 'Stripe', category: 'payments', status: 'live', apiDocs: 'https://docs.stripe.com/apis' },
  { id: 'firecrawl', name: 'Firecrawl', category: 'research', status: 'mcp_only', apiDocs: 'https://docs.firecrawl.dev/' },
  { id: 'infisical', name: 'Infisical', category: 'security', status: 'mcp_only', apiDocs: 'https://infisical.com/docs/api-reference/overview' },

  // Productivity, collaboration, and project management (24)
  { id: 'slack', name: 'Slack', category: 'communication', status: 'live', apiDocs: 'https://api.slack.com/' },
  { id: 'discord', name: 'Discord', category: 'communication', status: 'live', apiDocs: 'https://discord.com/developers/docs/intro', note: 'Read-only bot identity and guild metadata' },
  { id: 'line', name: 'LINE', category: 'communication', status: 'live', apiDocs: 'https://developers.line.biz/en/docs/messaging-api/' },
  { id: 'whatsapp-business', name: 'WhatsApp Business', category: 'communication', status: 'live', apiDocs: 'https://developers.facebook.com/docs/whatsapp/cloud-api', note: 'Read-only WABA phone metadata' },
  { id: 'microsoft-graph', name: 'Microsoft Graph', category: 'productivity', status: 'live', apiDocs: 'https://learn.microsoft.com/graph/', note: 'Read-only delegated signed-in-user metadata' },
  { id: 'zoom', name: 'Zoom', category: 'communication', status: 'live', apiDocs: 'https://developers.zoom.us/docs/api/', note: 'Read-only authenticated-user profile metadata' },
  { id: 'asana', name: 'Asana', category: 'project-management', status: 'live', apiDocs: 'https://developers.asana.com/docs' },
  { id: 'linear', name: 'Linear', category: 'project-management', status: 'live', apiDocs: 'https://linear.app/developers/graphql' },
  { id: 'monday', name: 'monday.com', category: 'project-management', status: 'live', apiDocs: 'https://developer.monday.com/api-reference/docs', note: 'Read-only board metadata' },
  { id: 'clickup', name: 'ClickUp', category: 'project-management', status: 'planned', apiDocs: 'https://developer.clickup.com/' },
  { id: 'trello', name: 'Trello', category: 'project-management', status: 'planned', apiDocs: 'https://developer.atlassian.com/cloud/trello/rest/' },
  { id: 'jira', name: 'Jira', category: 'project-management', status: 'planned', apiDocs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/' },
  { id: 'confluence', name: 'Confluence', category: 'knowledge', status: 'planned', apiDocs: 'https://developer.atlassian.com/cloud/confluence/rest/v2/' },
  { id: 'airtable', name: 'Airtable', category: 'database', status: 'planned', apiDocs: 'https://airtable.com/developers/web/api/introduction' },
  { id: 'miro', name: 'Miro', category: 'design', status: 'planned', apiDocs: 'https://developers.miro.com/docs' },
  { id: 'figma', name: 'Figma', category: 'design', status: 'planned', apiDocs: 'https://developers.figma.com/docs/' },
  { id: 'canva', name: 'Canva', category: 'design', status: 'planned', apiDocs: 'https://www.canva.dev/docs/connect/' },
  { id: 'loom', name: 'Loom', category: 'content', status: 'planned', apiDocs: 'https://developers.loom.com/' },
  { id: 'dropbox', name: 'Dropbox', category: 'storage', status: 'planned', apiDocs: 'https://www.dropbox.com/developers/documentation/http/documentation' },
  { id: 'box', name: 'Box', category: 'storage', status: 'planned', apiDocs: 'https://developer.box.com/reference/' },
  { id: 'docusign', name: 'DocuSign', category: 'legal', status: 'planned', apiDocs: 'https://developers.docusign.com/docs/esign-rest-api/' },
  { id: 'calendly', name: 'Calendly', category: 'scheduling', status: 'planned', apiDocs: 'https://developer.calendly.com/api-docs' },
  { id: 'cal-com', name: 'Cal.com', category: 'scheduling', status: 'planned', apiDocs: 'https://cal.com/docs/api-reference' },

  // CRM, support, and forms (10)
  { id: 'hubspot', name: 'HubSpot', category: 'crm', status: 'planned', apiDocs: 'https://developers.hubspot.com/docs/api/overview' },
  { id: 'salesforce', name: 'Salesforce', category: 'crm', status: 'planned', apiDocs: 'https://developer.salesforce.com/docs/apis' },
  { id: 'pipedrive', name: 'Pipedrive', category: 'crm', status: 'planned', apiDocs: 'https://developers.pipedrive.com/docs/api/v1' },
  { id: 'zoho-crm', name: 'Zoho CRM', category: 'crm', status: 'planned', apiDocs: 'https://www.zoho.com/crm/developer/docs/api/v8/' },
  { id: 'zendesk', name: 'Zendesk', category: 'customer-support', status: 'planned', apiDocs: 'https://developer.zendesk.com/api-reference/' },
  { id: 'intercom', name: 'Intercom', category: 'customer-support', status: 'planned', apiDocs: 'https://developers.intercom.com/docs/references/rest-api/api' },
  { id: 'freshdesk', name: 'Freshdesk', category: 'customer-support', status: 'planned', apiDocs: 'https://developers.freshdesk.com/api/' },
  { id: 'typeform', name: 'Typeform', category: 'forms', status: 'planned', apiDocs: 'https://www.typeform.com/developers/' },
  { id: 'surveymonkey', name: 'SurveyMonkey', category: 'forms', status: 'planned', apiDocs: 'https://api.surveymonkey.com/v3/docs' },
  { id: 'linkedin', name: 'LinkedIn', category: 'social', status: 'planned', apiDocs: 'https://learn.microsoft.com/linkedin/' },

  // Commerce, billing, and finance (16)
  { id: 'shopify', name: 'Shopify', category: 'commerce', status: 'planned', apiDocs: 'https://shopify.dev/docs/api' },
  { id: 'woocommerce', name: 'WooCommerce', category: 'commerce', status: 'planned', apiDocs: 'https://woocommerce.github.io/woocommerce-rest-api-docs/' },
  { id: 'bigcommerce', name: 'BigCommerce', category: 'commerce', status: 'planned', apiDocs: 'https://developer.bigcommerce.com/api-docs' },
  { id: 'etsy', name: 'Etsy', category: 'commerce', status: 'planned', apiDocs: 'https://developers.etsy.com/documentation/' },
  { id: 'ebay', name: 'eBay', category: 'commerce', status: 'planned', apiDocs: 'https://developer.ebay.com/api-docs/static/ebay-rest-landing.html' },
  { id: 'amazon-sp-api', name: 'Amazon Selling Partner API', category: 'commerce', status: 'planned', apiDocs: 'https://developer-docs.amazon.com/sp-api/' },
  { id: 'printful', name: 'Printful', category: 'commerce', status: 'planned', apiDocs: 'https://developers.printful.com/' },
  { id: 'gumroad', name: 'Gumroad', category: 'commerce', status: 'planned', apiDocs: 'https://gumroad.com/api' },
  { id: 'paypal', name: 'PayPal', category: 'payments', status: 'planned', apiDocs: 'https://developer.paypal.com/api/rest/' },
  { id: 'paddle', name: 'Paddle', category: 'payments', status: 'planned', apiDocs: 'https://developer.paddle.com/api-reference/overview' },
  { id: 'wise', name: 'Wise', category: 'finance', status: 'planned', apiDocs: 'https://docs.wise.com/api-docs/api-reference' },
  { id: 'quickbooks', name: 'QuickBooks', category: 'accounting', status: 'planned', apiDocs: 'https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/account' },
  { id: 'xero', name: 'Xero', category: 'accounting', status: 'planned', apiDocs: 'https://developer.xero.com/documentation/api/accounting/overview' },
  { id: 'plaid', name: 'Plaid', category: 'finance', status: 'planned', apiDocs: 'https://plaid.com/docs/api/' },
  { id: 'coingecko', name: 'CoinGecko', category: 'finance', status: 'planned', apiDocs: 'https://docs.coingecko.com/' },
  { id: 'kraken', name: 'Kraken', category: 'finance', status: 'planned', apiDocs: 'https://docs.kraken.com/api/' },

  // AI, data, and search (13)
  { id: 'openai', name: 'OpenAI', category: 'ai', status: 'planned', apiDocs: 'https://platform.openai.com/docs/api-reference' },
  { id: 'anthropic', name: 'Anthropic', category: 'ai', status: 'planned', apiDocs: 'https://docs.anthropic.com/en/api/overview' },
  { id: 'google-gemini', name: 'Google Gemini', category: 'ai', status: 'planned', apiDocs: 'https://ai.google.dev/api' },
  { id: 'cohere', name: 'Cohere', category: 'ai', status: 'planned', apiDocs: 'https://docs.cohere.com/reference' },
  { id: 'huggingface', name: 'Hugging Face', category: 'ai', status: 'planned', apiDocs: 'https://huggingface.co/docs/api-inference' },
  { id: 'replicate', name: 'Replicate', category: 'ai', status: 'planned', apiDocs: 'https://replicate.com/docs/reference/http' },
  { id: 'pinecone', name: 'Pinecone', category: 'ai-data', status: 'planned', apiDocs: 'https://docs.pinecone.io/reference/api/introduction' },
  { id: 'qdrant', name: 'Qdrant', category: 'ai-data', status: 'planned', apiDocs: 'https://qdrant.tech/documentation/' },
  { id: 'weaviate', name: 'Weaviate', category: 'ai-data', status: 'planned', apiDocs: 'https://weaviate.io/developers/weaviate/api' },
  { id: 'algolia', name: 'Algolia', category: 'search', status: 'planned', apiDocs: 'https://www.algolia.com/doc/rest-api/' },
  { id: 'alpha-vantage', name: 'Alpha Vantage', category: 'finance-data', status: 'planned', apiDocs: 'https://www.alphavantage.co/documentation/' },
  { id: 'openalex', name: 'OpenAlex', category: 'research', status: 'planned', apiDocs: 'https://docs.openalex.org/' },
  { id: 'crossref', name: 'Crossref', category: 'research', status: 'planned', apiDocs: 'https://api.crossref.org/' },

  // Maps, messaging, email, and social (17)
  { id: 'mapbox', name: 'Mapbox', category: 'maps', status: 'planned', apiDocs: 'https://docs.mapbox.com/api/' },
  { id: 'google-maps', name: 'Google Maps Platform', category: 'maps', status: 'planned', apiDocs: 'https://developers.google.com/maps/documentation' },
  { id: 'openweather', name: 'OpenWeather', category: 'weather', status: 'planned', apiDocs: 'https://openweathermap.org/api' },
  { id: 'foursquare', name: 'Foursquare', category: 'location', status: 'planned', apiDocs: 'https://docs.foursquare.com/developer/reference' },
  { id: 'twilio', name: 'Twilio', category: 'communication', status: 'planned', apiDocs: 'https://www.twilio.com/docs/usage/api' },
  { id: 'resend', name: 'Resend', category: 'email', status: 'planned', apiDocs: 'https://resend.com/docs/api-reference/introduction' },
  { id: 'sendgrid', name: 'SendGrid', category: 'email', status: 'planned', apiDocs: 'https://www.twilio.com/docs/sendgrid/api-reference' },
  { id: 'mailchimp', name: 'Mailchimp', category: 'email-marketing', status: 'planned', apiDocs: 'https://mailchimp.com/developer/marketing/api/' },
  { id: 'brevo', name: 'Brevo', category: 'email-marketing', status: 'planned', apiDocs: 'https://developers.brevo.com/' },
  { id: 'meta-graph', name: 'Meta Graph API', category: 'social', status: 'planned', apiDocs: 'https://developers.facebook.com/docs/graph-api/' },
  { id: 'instagram-graph', name: 'Instagram Graph API', category: 'social', status: 'planned', apiDocs: 'https://developers.facebook.com/docs/instagram-api/' },
  { id: 'youtube', name: 'YouTube Data API', category: 'social', status: 'planned', apiDocs: 'https://developers.google.com/youtube/v3' },
  { id: 'tiktok', name: 'TikTok for Developers', category: 'social', status: 'planned', apiDocs: 'https://developers.tiktok.com/doc/' },
  { id: 'reddit', name: 'Reddit', category: 'social', status: 'planned', apiDocs: 'https://www.reddit.com/dev/api/' },
  { id: 'x', name: 'X API', category: 'social', status: 'planned', apiDocs: 'https://docs.x.com/x-api/overview' },
  { id: 'pinterest', name: 'Pinterest', category: 'social', status: 'planned', apiDocs: 'https://developers.pinterest.com/docs/api/v5/' },
  { id: 'gitlab', name: 'GitLab', category: 'developer', status: 'planned', apiDocs: 'https://docs.gitlab.com/api/' },

  // Infrastructure and observability (4)
  { id: 'bitbucket', name: 'Bitbucket', category: 'developer', status: 'planned', apiDocs: 'https://developer.atlassian.com/cloud/bitbucket/rest/' },
  { id: 'posthog', name: 'PostHog', category: 'analytics', status: 'live', apiDocs: 'https://posthog.com/docs/api' },
  { id: 'sentry', name: 'Sentry', category: 'observability', status: 'live', apiDocs: 'https://docs.sentry.io/api/' },
  { id: 'datadog', name: 'Datadog', category: 'observability', status: 'planned', apiDocs: 'https://docs.datadoghq.com/api/latest/' },
  { id: 'grafana', name: 'Grafana', category: 'observability', status: 'planned', apiDocs: 'https://grafana.com/docs/grafana/latest/developers/http_api/' },
];
