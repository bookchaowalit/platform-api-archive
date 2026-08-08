import { createHmac, timingSafeEqual } from 'crypto';

export interface StripeSignatureResult {
  valid: boolean;
  timestamp?: number;
}

/**
 * Verify Stripe's signed webhook header without parsing or mutating the raw
 * request body. The v1 signature covers `${timestamp}.${rawBody}`.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  endpointSecret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): StripeSignatureResult {
  if (!signatureHeader || !endpointSecret) return { valid: false };

  const values = new Map<string, string[]>();
  for (const part of signatureHeader.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key || !value) continue;
    const entries = values.get(key) || [];
    entries.push(value);
    values.set(key, entries);
  }

  const timestampValue = values.get('t')?.[0];
  const timestamp = timestampValue ? Number(timestampValue) : NaN;
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false };
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBody,
  ]);
  const expected = createHmac('sha256', endpointSecret).update(signedPayload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  for (const candidate of values.get('v1') || []) {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    if (candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer)) {
      return { valid: true, timestamp };
    }
  }
  return { valid: false };
}
