import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify a LINE Messaging API webhook against the exact raw request body.
 * LINE signs the UTF-8 body with HMAC-SHA256 and sends the base64 digest in
 * the x-line-signature header.
 */
export function verifyLineSignature(
  rawBody: Buffer,
  signature: string | undefined,
  channelSecret: string | undefined,
): boolean {
  if (!signature || !channelSecret) return false;

  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  return received.length === expected.length && timingSafeEqual(received, expected);
}

export interface LineWebhookEvent {
  type: string;
  webhookEventId?: string;
  timestamp?: number;
  message?: { id?: string };
  [key: string]: unknown;
}

export function getLineEventExternalId(event: LineWebhookEvent): string | null {
  if (typeof event.webhookEventId === 'string' && event.webhookEventId.trim()) {
    return event.webhookEventId.trim();
  }
  if (typeof event.message?.id === 'string' && event.message.id.trim()) {
    return event.message.id.trim();
  }
  return null;
}
