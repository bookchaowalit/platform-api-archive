/**
 * Central email delivery through Resend (catalog ids: email, transactional-email).
 *
 * Sending is an outward-facing action, so the route stays in dry-run until
 * PLATFORM_EMAIL_SEND_ENABLED=true and RESEND_API_KEY + PLATFORM_EMAIL_FROM are
 * set. Dry-run validates and returns what would be sent without contacting
 * Resend. Message bodies are never logged.
 */
import { PlatformInputError, optionalString, requireObject, requireString } from './errors.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const MAX_RECIPIENTS = 50;
const MAX_BODY_CHARS = 200_000;
const EMAIL_PATTERN = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

export interface EmailConfig {
  sendEnabled: boolean;
  apiKey: string;
  from: string;
}

export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    sendEnabled: env.PLATFORM_EMAIL_SEND_ENABLED === 'true',
    apiKey: env.RESEND_API_KEY || '',
    from: env.PLATFORM_EMAIL_FROM || '',
  };
}

function recipients(body: Record<string, unknown>, field: 'to' | 'cc' | 'bcc', required: boolean): string[] {
  const raw = body[field];
  if (raw === undefined && !required) return [];
  const list = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(list) || (required && list.length === 0)) {
    throw new PlatformInputError(`${field} must be an email address or a non-empty list of them`);
  }
  return list.map((value) => {
    if (typeof value !== 'string' || value.length > 254 || !EMAIL_PATTERN.test(value.trim())) {
      throw new PlatformInputError(`${field} contains an invalid email address`);
    }
    return value.trim().toLowerCase();
  });
}

export interface EmailRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  tags: Array<{ name: string; value: string }>;
}

export function parseEmailRequest(input: unknown): EmailRequest {
  const body = requireObject(input);
  const to = recipients(body, 'to', true);
  const cc = recipients(body, 'cc', false);
  const bcc = recipients(body, 'bcc', false);
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new PlatformInputError(`at most ${MAX_RECIPIENTS} recipients per message`);
  }
  const subject = requireString(body, 'subject', 200);
  if (/[\r\n]/.test(subject)) throw new PlatformInputError('subject must be a single line');
  const html = optionalString(body, 'html', MAX_BODY_CHARS);
  const text = optionalString(body, 'text', MAX_BODY_CHARS);
  if (!html && !text) throw new PlatformInputError('html or text is required');
  const replyTo = optionalString(body, 'reply_to', 254);
  if (replyTo && !EMAIL_PATTERN.test(replyTo)) throw new PlatformInputError('reply_to is not a valid email address');
  const app = optionalString(body, 'app', 63);
  if (app && !/^[a-z0-9][a-z0-9-]*$/.test(app)) throw new PlatformInputError('app must be a lower-case slug');
  return { to, cc, bcc, subject, html, text, reply_to: replyTo, tags: app ? [{ name: 'app', value: app }] : [] };
}

/** POST /api/platform/messages/email */
export async function sendEmail(
  input: unknown,
  config: EmailConfig = emailConfigFromEnv(),
  fetchImpl: typeof fetch = fetch,
) {
  const message = parseEmailRequest(input);
  const summary = {
    recipients: message.to.length + message.cc.length + message.bcc.length,
    subject: message.subject,
    has_html: Boolean(message.html),
    has_text: Boolean(message.text),
  };
  if (!config.sendEnabled || !config.apiKey || !config.from) {
    const missing = [
      !config.sendEnabled && 'PLATFORM_EMAIL_SEND_ENABLED',
      !config.apiKey && 'RESEND_API_KEY',
      !config.from && 'PLATFORM_EMAIL_FROM',
    ].filter(Boolean);
    return { status: 'dry_run' as const, provider: 'resend', reason: `not enabled: ${missing.join(', ')}`, ...summary };
  }
  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.from,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      bcc: message.bcc.length ? message.bcc : undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: message.reply_to,
      tags: message.tags.length ? message.tags : undefined,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    // Do not relay the provider body; it can echo addresses or content.
    throw new PlatformInputError(`email provider rejected the message (HTTP ${response.status})`, 502);
  }
  const data = (await response.json().catch(() => ({}))) as { id?: string };
  return { status: 'sent' as const, provider: 'resend', provider_message_id: data.id ?? null, ...summary };
}
